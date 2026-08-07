/**
 * La frontera del §M3. Lo que se prueba aquí no es SQL: es que la ruta de
 * reputación no dependa de dónde salen los datos, y que la dirección pedida
 * llegue de verdad hasta la consulta.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "../index.js";
import { __setReputationSource, type MerchantReputation, type ReputationSource } from "../lib/reputation-source.js";
import type { FastifyInstance } from "fastify";

const PAGO = { "x-payment": "mock:GAGENTE:0.0005" };

const comercio = (address: string, over: Partial<MerchantReputation> = {}): MerchantReputation => ({
  stellar_address: address,
  display_name: "Abarrotes de prueba",
  location: "CDMX",
  trades_completed: 47,
  completion_rate: 0.9362,
  avg_time_minutes: 12,
  total_volume_usdc: 8412.5,
  verified_at: "2026-05-14T18:22:00.000Z",
  ...over,
});

/** Doble que registra qué dirección le pidieron. */
function fuenteFalsa(porDireccion: Record<string, MerchantReputation>) {
  const pedidas: string[] = [];
  const source: ReputationSource & { pedidas: string[] } = {
    kind: "http",
    pedidas,
    async byAddress(addr) {
      pedidas.push(addr);
      return porDireccion[addr] ?? null;
    },
    async listVerified() {
      return Object.values(porDireccion);
    },
  };
  return source;
}

const A = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKUJI5KOOJ9TXWNTBBS2JN";
const B = "GDKKW2WSMQWZ63PIZBKDDBAAOBG5FP3TUHRYQ4U5RBKTFNESL5K5BJJK";

describe("frontera §M3 — fuente de reputación", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    // La ruta va detrás de x402. El bypass "mock:" exige esta bandera y que
    // NODE_ENV no sea production — index.ts se niega a arrancar con las dos.
    process.env.X402_MOCK_MODE = "true";
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
    __setReputationSource(null);
  });

  it("consulta la dirección pedida, no la primera que encuentre", async () => {
    // REGRESIÓN. La consulta original no filtraba por dirección: ordenaba por
    // verified_at y devolvía LIMIT 1. Cualquier dirección válida obtenía
    // siempre el mismo comercio, en la ruta cuya única función es decidir si
    // fiarse de UNO en concreto.
    const fuente = fuenteFalsa({
      [A]: comercio(A, { display_name: "Comercio A" }),
      [B]: comercio(B, { display_name: "Comercio B" }),
    });
    __setReputationSource(fuente);

    const res = await app.inject({ method: "GET", url: `/api/v1/reputation/${B}`, headers: PAGO });

    expect(res.statusCode).toBe(200);
    expect(fuente.pedidas).toEqual([B]);
    expect(res.json().address).toBe(B);
    expect(res.json().merchant.name).toBe("Comercio B");
  });

  it("404 cuando la dirección no es un comercio verificado", async () => {
    __setReputationSource(fuenteFalsa({ [A]: comercio(A) }));

    const res = await app.inject({ method: "GET", url: `/api/v1/reputation/${B}`, headers: PAGO });

    expect(res.statusCode).toBe(404);
    expect(res.json().address).toBe(B);
  });

  it("fuente caída devuelve 503, no 404", async () => {
    // Un 404 le dice al agente "este comercio no es de fiar". Si lo que pasa
    // es que no sabemos, hay que decir que no sabemos: son decisiones
    // distintas y el agente actúa sobre ellas.
    __setReputationSource({
      kind: "http",
      async byAddress() { throw new Error("backend móvil respondió 500"); },
      async listVerified() { throw new Error("backend móvil respondió 500"); },
    });

    const res = await app.inject({ method: "GET", url: `/api/v1/reputation/${A}`, headers: PAGO });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("unavailable");
  });

  it("el tier lo calcula este repo, no la fuente", async () => {
    // El contrato con el backend móvil pide números crudos: los tiers cambian
    // con criterios de agentes, no de retail.
    __setReputationSource(fuenteFalsa({
      [A]: comercio(A, { trades_completed: 120, completion_rate: 0.97 }),
    }));

    const res = await app.inject({ method: "GET", url: `/api/v1/reputation/${A}`, headers: PAGO });

    expect(res.json().reputation.tier).toBe("maestro");
    expect(res.json().agent_signal.risk_level).toBe("low");
  });

  it("la ruta no sabe de qué fuente vienen los datos", async () => {
    // El mismo cuerpo con la opción (a) y con la (b). Cambiar de una a otra
    // es una variable de entorno, no un refactor.
    const datos = { [A]: comercio(A) };
    const respuestas: unknown[] = [];

    for (const kind of ["direct-db", "http"] as const) {
      __setReputationSource({ ...fuenteFalsa(datos), kind });
      const res = await app.inject({ method: "GET", url: `/api/v1/reputation/${A}`, headers: PAGO });
      const body = res.json();
      delete body.queried_at; // lo único que cambia entre llamadas
      respuestas.push(body);
    }

    expect(respuestas[0]).toEqual(respuestas[1]);
  });
});
