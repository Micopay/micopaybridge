/**
 * `/api/v1/swaps/execute` contra un plan vencido y contra uno que no existe.
 *
 * El plan se paga ($0.01). Contestar 404 a los dos casos dejaba al agente sin
 * forma de saber si tenía que crear otro plan o si le habíamos perdido el
 * suyo, y sin más salida que pagar de nuevo. Son dos respuestas distintas
 * (#17).
 *
 * En tests `SWAP_STORE_DIR` va vacío, así que el store corre en memoria: lo
 * que se prueba aquí es la ruta, no la persistencia — de eso va
 * plan-store.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "../index.js";
import { planStore } from "../lib/swapStore.js";
import type { FastifyInstance } from "fastify";

const DEMO_AGENT_ADDRESS_PLACEHOLDER = "GDEMOAGENTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

const plan = (id: string) => ({
  id,
  sell_asset: "USDC",
  sell_amount: "1",
  buy_asset: "XRP",
  buy_amount: "1",
  exchange_rate: "1",
  counterparty_address: DEMO_AGENT_ADDRESS_PLACEHOLDER,
  initiator_ledgers: 240,
  counterparty_ledgers: 120,
  risk_level: "medium",
  estimated_time_seconds: 120,
  created_at: new Date().toISOString(),
});

const ejecutar = (app: FastifyInstance, plan_id: string) =>
  app.inject({
    method: "POST",
    url: "/api/v1/swaps/execute",
    headers: { "x-payment": "mock:GTEST_EXEC:0.05", "content-type": "application/json" },
    payload: { plan_id },
  });

describe("POST /api/v1/swaps/execute — plan vencido vs plan desconocido", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.X402_MOCK_MODE = "true";
    app = await createApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it("un plan vencido devuelve 410 plan_expired", async () => {
    planStore.set("plan_vencido_http", plan("plan_vencido_http"), 1);
    await new Promise((r) => setTimeout(r, 5));

    const res = await ejecutar(app, "plan_vencido_http");

    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ error: "plan_expired" });
  });

  it("un plan_id desconocido devuelve 404 plan_not_found", async () => {
    const res = await ejecutar(app, "plan_que_no_existe_http");

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "plan_not_found" });
  });

  it("las dos respuestas no se confunden entre sí", async () => {
    // La propiedad que importa: quien pagó puede distinguir "crea otro plan"
    // de "esto es un bug nuestro" sin adivinar.
    planStore.set("plan_vencido_distinto", plan("plan_vencido_distinto"), 1);
    await new Promise((r) => setTimeout(r, 5));

    const vencido = await ejecutar(app, "plan_vencido_distinto");
    const desconocido = await ejecutar(app, "otro_que_no_existe");

    expect(vencido.statusCode).not.toBe(desconocido.statusCode);
    expect(vencido.json().error).not.toBe(desconocido.json().error);
    expect(vencido.json().message).not.toBe(desconocido.json().message);
  });
});
