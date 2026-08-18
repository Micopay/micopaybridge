import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

/**
 * `secret_hash` obligatorio en POST /api/v1/bazaar/accept.
 *
 * Antes, si el llamador no mandaba `secret_hash`, el servidor inventaba 32
 * bytes al azar, los hasheaba, bloqueaba un HTLC contra ese hash, y tiraba los
 * bytes. La preimagen es la unica llave que abre ese escrow: destruirla dejaba
 * los fondos irrecuperables, y no hay endpoint de reembolso para intents del
 * bazaar.
 *
 * En un protocolo no custodial la preimagen la genera el iniciador y se la
 * queda. El servidor solo debe ver `sha256(preimagen)`.
 *
 * Corre offline: se mockean el servicio de Stellar y la capa de base.
 */

const INTENT_ID = "int-test-hash";
const HASH_VALIDO = "a3f1".repeat(16); // 64 hex en minuscula

const activeIntent = {
  id: INTENT_ID,
  agent_address: "GTESTAGENT",
  status: "active" as const,
  wanted_symbol: "USDC",
  wanted_amount: "10",
  offered_symbol: "XRP",
  offered_amount: "20",
  secret_hash: null,
  selected_quote_id: null,
  created_at: new Date().toISOString(),
};

vi.mock("../services/stellar.service.js", () => ({
  lockAtomicSwap: vi.fn(),
}));

vi.mock("../db/bazaar.js", () => ({
  initBazaarTables: vi.fn(async () => {}),
  seedAgentHistories: vi.fn(async () => {}),
  seedIntents: vi.fn(async () => {}),
  createIntent: vi.fn(async (i: unknown) => i),
  getIntent: vi.fn(async () => ({ ...activeIntent })),
  getActiveIntents: vi.fn(async () => []),
  updateIntent: vi.fn(async () => {}),
  createQuote: vi.fn(async (q: unknown) => q),
  getQuotesForIntent: vi.fn(async () => []),
  getAgentHistory: vi.fn(async () => null),
  upsertAgentHistory: vi.fn(async () => {}),
  intentRowToObject: (row: unknown) => row,
  getBazaarStats: vi.fn(async () => ({})),
}));

import { bazaarRoutes } from "../routes/bazaar.js";
import { lockAtomicSwap } from "../services/stellar.service.js";
import { updateIntent } from "../db/bazaar.js";

const PAGO = { "x-payment": "mock:GTESTBAZAAR:0.005", "content-type": "application/json" };

describe("POST /api/v1/bazaar/accept, secret_hash obligatorio", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.X402_MOCK_MODE = "true";
    app = Fastify();
    await app.register(bazaarRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.X402_MOCK_MODE;
  });

  beforeEach(() => {
    vi.mocked(lockAtomicSwap).mockClear();
    vi.mocked(updateIntent).mockClear();
    vi.mocked(lockAtomicSwap).mockResolvedValue({
      txHash: "tx123",
      swapId: "swap123",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/tx123",
    });
  });

  function accept(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/bazaar/accept",
      headers: PAGO,
      payload,
    });
  }

  it("sin secret_hash responde 400 y no bloquea nada", async () => {
    const res = await accept({ intent_id: INTENT_ID });

    expect(res.statusCode).toBe(400);
    expect(vi.mocked(lockAtomicSwap)).not.toHaveBeenCalled();
    expect(vi.mocked(updateIntent)).not.toHaveBeenCalled();
  });

  it("el mensaje de error nombra el campo que falta", async () => {
    const res = await accept({ intent_id: INTENT_ID });

    const body = JSON.parse(res.body);
    expect(body.message).toContain("secret_hash");
  });

  const malformados: Array<[string, string]> = [
    ["demasiado corto", "abc123"],
    ["un caracter de menos", "a".repeat(63)],
    ["un caracter de mas", "a".repeat(65)],
    ["no hexadecimal", "z".repeat(64)],
    ["en mayusculas", "A3F1".repeat(16)],
    ["con prefijo 0x", "0x" + "a".repeat(62)],
    ["vacio", ""],
  ];

  it.each(malformados)("secret_hash %s responde 400 y no bloquea nada", async (_caso, hash) => {
    const res = await accept({ intent_id: INTENT_ID, secret_hash: hash });

    expect(res.statusCode).toBe(400);
    expect(vi.mocked(lockAtomicSwap)).not.toHaveBeenCalled();
    expect(vi.mocked(updateIntent)).not.toHaveBeenCalled();
  });

  it("un secret_hash valido de 64 hex es aceptado y llega intacto al lock", async () => {
    const res = await accept({ intent_id: INTENT_ID, secret_hash: HASH_VALIDO });

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(lockAtomicSwap)).toHaveBeenCalledOnce();

    // El hash que recibe el lock tiene que ser exactamente el que mando el
    // cliente, sin normalizar ni regenerar.
    const args = vi.mocked(lockAtomicSwap).mock.calls[0][0];
    expect(args.secretHash).toBe(HASH_VALIDO);

    const body = JSON.parse(res.body);
    expect(body.handshake.secret_hash).toBe(HASH_VALIDO);
  });

  it("dos llamadas con hashes distintos no se mezclan", async () => {
    const otro = "b2c4".repeat(16);

    await accept({ intent_id: INTENT_ID, secret_hash: HASH_VALIDO });
    await accept({ intent_id: INTENT_ID, secret_hash: otro });

    const llamadas = vi.mocked(lockAtomicSwap).mock.calls;
    expect(llamadas).toHaveLength(2);
    expect(llamadas[0][0].secretHash).toBe(HASH_VALIDO);
    expect(llamadas[1][0].secretHash).toBe(otro);
  });

  it("el codigo de la ruta ya no genera preimagenes del lado del servidor", async () => {
    // Prueba estructural: si alguien reintroduce randomBytes en esta ruta, el
    // servidor vuelve a poder inventar una preimagen y tirarla.
    const { readFileSync } = await import("fs");
    const { fileURLToPath } = await import("url");
    const { dirname, join } = await import("path");

    const aqui = dirname(fileURLToPath(import.meta.url));
    const fuente = readFileSync(join(aqui, "..", "routes", "bazaar.ts"), "utf-8");

    expect(fuente).not.toContain("randomBytes");
  });
});
