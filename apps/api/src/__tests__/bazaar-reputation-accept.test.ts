import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

const INTENT_ID = "int-reputation-test";
const AUTHOR = "GAUTHOR";
const ACCEPTOR = "GACCEPTOR";

const activeIntent = {
  id: INTENT_ID,
  agent_address: AUTHOR,
  status: "active" as const,
  wanted_symbol: "USDC",
  wanted_amount: "25",
  offered_symbol: "XRP",
  offered_amount: "50",
  secret_hash: null,
  selected_quote_id: null,
  created_at: new Date().toISOString(),
};

const histories = new Map<string, any>();

vi.mock("../services/stellar.service.js", () => ({
  lockAtomicSwap: vi.fn(async () => ({
    txHash: "tx-reputation-test",
    swapId: "swap-reputation-test",
    explorerUrl: "https://stellar.expert/explorer/testnet/tx/tx-reputation-test",
  })),
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
  getAgentHistory: vi.fn(async (address: string) => histories.get(address) ?? null),
  upsertAgentHistory: vi.fn(async (address: string, delta: Record<string, number>) => {
    const current = histories.get(address) ?? {
      broadcasts: 0,
      swaps_completed: 0,
      swaps_cancelled: 0,
      volume_usdc: 0,
      first_seen: "2026-01-01T00:00:00.000Z",
      last_active: "2026-01-01T00:00:00.000Z",
    };
    const updated = {
      ...current,
      broadcasts: current.broadcasts + (delta.broadcasts ?? 0),
      swaps_completed: current.swaps_completed + (delta.swaps_completed ?? 0),
      swaps_cancelled: current.swaps_cancelled + (delta.swaps_cancelled ?? 0),
      volume_usdc: current.volume_usdc + (delta.volume_usdc ?? 0),
    };
    histories.set(address, updated);
    return updated;
  }),
  intentRowToObject: (row: unknown) => row,
  getBazaarStats: vi.fn(async () => ({})),
}));

import { bazaarRoutes } from "../routes/bazaar.js";
import { upsertAgentHistory } from "../db/bazaar.js";

const PAGO = {
  "x-payment": `mock:${ACCEPTOR}:0.005`,
  "content-type": "application/json",
};

describe("Bazaar reputation accounting on accept", () => {
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
    histories.clear();
    histories.set(AUTHOR, {
      broadcasts: 5,
      swaps_completed: 4,
      swaps_cancelled: 1,
      volume_usdc: 100,
      first_seen: "2026-01-01T00:00:00.000Z",
      last_active: "2026-08-01T00:00:00.000Z",
    });
    histories.set(ACCEPTOR, {
      broadcasts: 3,
      swaps_completed: 2,
      swaps_cancelled: 0,
      volume_usdc: 50,
      first_seen: "2026-02-01T00:00:00.000Z",
      last_active: "2026-08-02T00:00:00.000Z",
    });
    vi.mocked(upsertAgentHistory).mockClear();
  });

  it("does not count accept as completion for either participant", async () => {
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/bazaar/accept",
      headers: PAGO,
      payload: {
        intent_id: INTENT_ID,
        secret_hash: "c".repeat(64),
        amount_usdc: 25,
      },
    });

    expect(accepted.statusCode).toBe(200);
    const acceptedBody = JSON.parse(accepted.body);
    expect(acceptedBody.agent_reputation_updated).toBe(false);
    expect(acceptedBody.reputation_update).toBe("deferred_until_settlement");
    expect(vi.mocked(upsertAgentHistory)).not.toHaveBeenCalled();

    const authorResponse = await app.inject({
      method: "GET",
      url: `/api/v1/bazaar/reputation/${AUTHOR}`,
    });
    const acceptorResponse = await app.inject({
      method: "GET",
      url: `/api/v1/bazaar/reputation/${ACCEPTOR}`,
    });

    expect(authorResponse.statusCode).toBe(200);
    expect(acceptorResponse.statusCode).toBe(200);

    const author = JSON.parse(authorResponse.body).agent_reputation;
    const acceptor = JSON.parse(acceptorResponse.body).agent_reputation;

    expect(author.swaps_completed).toBe(4);
    expect(author.volume_usdc_total).toBe("100");
    expect(acceptor.swaps_completed).toBe(2);
    expect(acceptor.volume_usdc_total).toBe("50");
  });
});
