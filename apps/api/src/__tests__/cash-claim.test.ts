/**
 * SEC-02 en apps/api — el QR ya no transporta el preimage HTLC.
 *
 * Antes, `POST /cash/request` devolvía un `qr_payload` con `secret=<preimage>`
 * a quien llamaba. El que pagaba $0.01 podía liberar el escrow contra el
 * contrato SIN entregar el efectivo, mientras la propia respuesta afirmaba
 * "USDC releases only when merchant scans QR".
 *
 * Port del arreglo que el equipo ya hizo en micopay/backend: token opaco de un
 * solo uso, del que solo se guarda el sha256.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "../index.js";
import { claimTokens } from "../routes/cash.js";
import { createHash } from "crypto";
import type { FastifyInstance } from "fastify";

const PAGO = { "x-payment": "mock:GAGENTE:1.0" };

describe("SEC-02 — el QR no lleva el preimage", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.X402_MOCK_MODE = "true";
    app = await createApp();
  });
  afterEach(async () => { await app.close(); });

  async function pedirEfectivo() {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cash/request",
      headers: { ...PAGO, "content-type": "application/json" },
      payload: { merchant_address: "GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG", amount_mxn: 500 },
    });
    return res;
  }

  it("ni el QR ni la respuesta contienen la preimagen", async () => {
    const res = await pedirEfectivo();
    expect(res.statusCode).toBe(201);

    const body = res.json();
    const crudo = JSON.stringify(body);

    // El hash sí puede viajar; el secreto no.
    expect(body.qr_payload).not.toMatch(/secret=/);
    expect(body.qr_payload).toMatch(/token=[0-9a-f]{64}/);
    expect(crudo).not.toContain(body.htlc_secret ?? "__nunca__");
    expect(body.htlc_secret).toBeUndefined();
  });

  it("el token del QR se canjea una sola vez", async () => {
    const res = await pedirEfectivo();
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const token = new URL(body.qr_payload.replace("micopay://", "https://")).searchParams.get("token");
    const id = body.request_id;

    const primero = await app.inject({
      method: "POST", url: `/api/v1/cash/request/${id}/claim`,
      headers: { "content-type": "application/json" }, payload: { token },
    });
    expect(primero.statusCode).toBe(200);
    // El preimage se entrega AQUÍ, no antes.
    expect(primero.json().htlc_secret).toMatch(/^[0-9a-f]{64}$/);

    const segundo = await app.inject({
      method: "POST", url: `/api/v1/cash/request/${id}/claim`,
      headers: { "content-type": "application/json" }, payload: { token },
    });
    expect(segundo.statusCode).toBe(409);
    expect(segundo.json().error).toBe("CLAIM_TOKEN_USED");
  });

  it("un token de otra petición no sirve", async () => {
    const a = await pedirEfectivo();
    const b = await pedirEfectivo();
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);

    const tokenDeA = new URL(a.json().qr_payload.replace("micopay://", "https://")).searchParams.get("token");
    const idDeB = b.json().request_id;

    const res = await app.inject({
      method: "POST", url: `/api/v1/cash/request/${idDeB}/claim`,
      headers: { "content-type": "application/json" }, payload: { token: tokenDeA },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("INVALID_CLAIM_TOKEN");
  });

  it("un token inventado no sirve", async () => {
    const res0 = await pedirEfectivo();
    expect(res0.statusCode).toBe(201);

    const res = await app.inject({
      method: "POST", url: `/api/v1/cash/request/${res0.json().request_id}/claim`,
      headers: { "content-type": "application/json" }, payload: { token: "ff".repeat(32) },
    });
    expect(res.statusCode).toBe(404);
  });

  it("el claim rechaza a un comercio distinto del de la petición", async () => {
    const res0 = await pedirEfectivo();
    expect(res0.statusCode).toBe(201);
    const body = res0.json();
    const token = new URL(body.qr_payload.replace("micopay://", "https://")).searchParams.get("token");

    const res = await app.inject({
      method: "POST", url: `/api/v1/cash/request/${body.request_id}/claim`,
      headers: { "content-type": "application/json" },
      payload: { token, merchant_address: "GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("MERCHANT_MISMATCH");
  });

  it("amount_mxn no numérico se rechaza en vez de colarse como NaN", async () => {
    // "abc" < 50 y "abc" > 5000 dan las dos false (NaN): sin Number.isFinite
    // esto pasaba con 201 y dejaba amount_usdc:"NaN" en la respuesta.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cash/request",
      headers: { ...PAGO, "content-type": "application/json" },
      payload: { merchant_address: "GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG", amount_mxn: "abc" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("el claim sin merchant_address no atribuye el canje al comercio legítimo", async () => {
    const res0 = await pedirEfectivo();
    expect(res0.statusCode).toBe(201);
    const body = res0.json();
    const token = new URL(body.qr_payload.replace("micopay://", "https://")).searchParams.get("token");

    // Portador sin identificarse: el claim sigue aceptándose (WAVE5 Issue 8,
    // sin auth de comercio todavía), pero el registro NO debe fingir que fue
    // el comercio de la petición quien canjeó.
    const res = await app.inject({
      method: "POST", url: `/api/v1/cash/request/${body.request_id}/claim`,
      headers: { "content-type": "application/json" }, payload: { token },
    });
    expect(res.statusCode).toBe(200);

    const tokenHash = createHash("sha256").update(token!).digest("hex");
    const entry = claimTokens.get(tokenHash);
    // Antes del fix esto era el merchant_address de la petición — atribuía el
    // canje al comercio legítimo aunque lo hubiera hecho cualquier portador.
    expect(entry?.consumed_by).toBeNull();
  });
});

describe("/api/v1/fund/demo — grifo cerrado", () => {
  let app: FastifyInstance;
  afterEach(async () => { await app.close(); });

  it("responde 403 fuera de modo demo", async () => {
    // Gastaba 0.10 USDC reales por llamada, gratis y sin autenticación.
    delete process.env.X402_MOCK_MODE;
    app = await createApp();

    const res = await app.inject({ method: "POST", url: "/api/v1/fund/demo" });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("disabled");
  });
});
