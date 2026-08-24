import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

/**
 * Cobertura del camino de fallo del lock on-chain en POST /api/v1/bazaar/accept.
 *
 * Antes, cuando el lock fallaba, `lockAtomicSwap` devolvia un txHash fabricado
 * (`demo_atomic_<timestamp>`) y la ruta respondia 200 con `status: negotiating`.
 * Un agente automatizado no tenia forma de distinguir eso de un lock real, asi
 * que seguia al paso siguiente creyendo que habia fondos en garantia cuando no
 * se habia bloqueado nada.
 *
 * Estos tests corren offline: se mockean tanto el servicio de Stellar como la
 * capa de base, asi que no hacen red ni necesitan Postgres.
 */

const INTENT_ID = "int-test-lock";

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
import { getIntent, updateIntent, upsertAgentHistory } from "../db/bazaar.js";

const PAGO = { "x-payment": "mock:GTESTBAZAAR:0.005", "content-type": "application/json" };

describe("POST /api/v1/bazaar/accept, fallo del lock on-chain", () => {
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
    vi.mocked(updateIntent).mockClear();
    vi.mocked(upsertAgentHistory).mockClear();
    vi.mocked(getIntent).mockResolvedValue({ ...activeIntent } as never);
  });

  async function acceptConLockRoto(mensaje = "soroban rpc unreachable") {
    vi.mocked(lockAtomicSwap).mockRejectedValueOnce(new Error(mensaje));
    return app.inject({
      method: "POST",
      url: "/api/v1/bazaar/accept",
      headers: PAGO,
      payload: {
        intent_id: INTENT_ID,
        secret_hash: "a".repeat(64),
        amount_usdc: 1,
      },
    });
  }

  it("responde 502 cuando el lock falla, no 200", async () => {
    const res = await acceptConLockRoto();

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("On-chain lock failed");
    expect(body.message).toContain("No funds were locked");
  });

  it("el cuerpo no contiene ningun hash fabricado ni link de explorador", async () => {
    const res = await acceptConLockRoto();

    expect(res.body).not.toContain("demo_atomic_");
    expect(res.body).not.toContain("stellar.expert");
  });

  it("el intent no se modifica: sigue active y updateIntent no se llama", async () => {
    const res = await acceptConLockRoto();

    const body = JSON.parse(res.body);
    expect(body.intent_status).toBe("active");
    expect(vi.mocked(updateIntent)).not.toHaveBeenCalled();
  });

  it("no se escribe reputacion: agent_history queda intacto", async () => {
    await acceptConLockRoto();

    expect(vi.mocked(upsertAgentHistory)).not.toHaveBeenCalled();
  });

  it("informa el motivo real del fallo, para que sea accionable", async () => {
    const res = await acceptConLockRoto("insufficient platform balance");

    const body = JSON.parse(res.body);
    expect(body.reason).toContain("insufficient platform balance");
  });

  it("el camino feliz responde 200, muta el intent y difiere la reputacion", async () => {
    vi.mocked(lockAtomicSwap).mockResolvedValueOnce({
      txHash: "abc123",
      swapId: "def456",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/abc123",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bazaar/accept",
      headers: PAGO,
      payload: {
        intent_id: INTENT_ID,
        secret_hash: "b".repeat(64),
        amount_usdc: 1,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("negotiating");
    expect(body.handshake.htlc_tx_hash).toBe("abc123");
    expect(body.agent_reputation_updated).toBe(false);
    expect(body.reputation_update).toBe("deferred_until_settlement");

    expect(vi.mocked(updateIntent)).toHaveBeenCalledOnce();
    expect(vi.mocked(upsertAgentHistory)).not.toHaveBeenCalled();
  });
});
