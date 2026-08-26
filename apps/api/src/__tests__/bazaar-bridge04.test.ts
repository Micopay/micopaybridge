import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

/**
 * BRIDGE-04 acceptance criteria:
 *
 * 1. An intent whose expires_at is in the past does NOT appear in GET /api/v1/bazaar/feed.
 * 2. Such an intent ends up with status = 'expired' (expireStaleIntents sweep).
 * 3. GET /api/v1/bazaar/stats never reports data_source: "PostgreSQL" when serving
 *    the static fallback.
 * 4. The fallback response carries degraded: true.
 *
 * This file covers the /stats fallback (3 & 4) and the route-level behavior of
 * the feed. The feed's exclusion itself is enforced by the SQL in
 * db/bazaar.ts — the UPDATE sweep and the `expires_at > NOW()` WHERE clause —
 * and that SQL is exercised for real in bazaar-bridge04-db.test.ts, against a
 * mocked schema layer.
 *
 * Runs offline — both the stellar service and the db layer are mocked.
 */

// ── fixtures ──────────────────────────────────────────────────────────────────

const FUTURE = new Date(Date.now() + 50 * 60 * 1000).toISOString(); // 50 min ahead

const activeIntent = {
  id: "int-active",
  agent_address: "GACTIVE0000000000000000000000000000000000000000000000000",
  offered_chain: "stellar",  offered_symbol: "USDC", offered_amount: "500",
  wanted_chain:  "physical", wanted_symbol:  "MXN",  wanted_amount: "8750",
  min_rate: null,
  status: "active" as const,
  created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  expires_at: FUTURE,
  reputation_tier: null,
  secret_hash: null,
  selected_quote_id: null,
};

// ── mocks ─────────────────────────────────────────────────────────────────────
// IMPORTANT: vi.mock factories are hoisted to the top of the file by the
// vitest transformer. The mock functions must therefore be created inline
// (not referenced from module-level `const` declarations, which are hoisted
// separately and would cause "Cannot access before initialization").
// We retrieve the mocks AFTER the mock is registered via vi.mocked().

vi.mock("../services/stellar.service.js", () => ({
  lockAtomicSwap: vi.fn(),
}));

vi.mock("../db/bazaar.js", () => ({
  initBazaarTables:    vi.fn(async () => {}),
  seedAgentHistories:  vi.fn(async () => {}),
  seedIntents:         vi.fn(async () => {}),
  createIntent:        vi.fn(async (i: unknown) => i),
  getIntent:           vi.fn(async () => null),
  getActiveIntents:    vi.fn(async () => []),
  updateIntent:        vi.fn(async () => {}),
  createQuote:         vi.fn(async (q: unknown) => q),
  getQuotesForIntent:  vi.fn(async () => []),
  getAgentHistory:     vi.fn(async () => null),
  upsertAgentHistory:  vi.fn(async () => {}),
  intentRowToObject:   (row: unknown) => row,
  getBazaarStats:      vi.fn(async () => ({})),
}));

import { bazaarRoutes } from "../routes/bazaar.js";
import * as bazaarDb from "../db/bazaar.js";

const PAYMENT_HEADER = {
  "x-payment":    "mock:GTESTBAZAAR:0.001",
  "content-type": "application/json",
};

// ── feed: route forwards the db layer's result ────────────────────────────────
// The route is a thin forwarder: it returns whatever getActiveIntents() gives
// it. The exclusion of expired intents is enforced by the SQL inside
// db/bazaar.ts (sweep + `expires_at > NOW()`), which is what
// bazaar-bridge04-db.test.ts exercises against a mocked schema.

describe("GET /api/v1/bazaar/feed — route behavior (BRIDGE-04)", () => {
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
    vi.mocked(bazaarDb.getActiveIntents).mockClear();
  });

  it("serves exactly the intents getActiveIntents() returns", async () => {
    vi.mocked(bazaarDb.getActiveIntents).mockResolvedValueOnce([activeIntent] as any);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/bazaar/feed",
      headers: PAYMENT_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    const ids = body.intents.map((i: { id: string }) => i.id);
    expect(ids).toEqual([activeIntent.id]);
    expect(body.count).toBe(1);
  });

  it("serves an empty feed when the db layer returns nothing", async () => {
    vi.mocked(bazaarDb.getActiveIntents).mockResolvedValueOnce([] as any);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/bazaar/feed",
      headers: PAYMENT_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.intents).toHaveLength(0);
    expect(body.count).toBe(0);
  });
});

// ── /stats fallback: data_source and degraded ─────────────────────────────────

describe("GET /api/v1/bazaar/stats — fallback data_source (BRIDGE-04)", () => {
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
    vi.mocked(bazaarDb.getBazaarStats).mockClear();
  });

  it("reports data_source: 'PostgreSQL' when the DB call succeeds", async () => {
    vi.mocked(bazaarDb.getBazaarStats).mockResolvedValueOnce({
      total_intents: 5, active_intents: 3, negotiating_intents: 1,
      executed_intents: 1, expired_intents: 0, total_volume_usdc: 1000,
      total_broadcasts: 10, total_swaps_completed: 8, total_swaps_cancelled: 1,
      top_agents: [], recent_intents: [],
    } as any);

    const res = await app.inject({ method: "GET", url: "/api/v1/bazaar/stats" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data_source).toBe("PostgreSQL");
    expect(body.degraded).toBeUndefined();
  });

  it("never reports data_source: 'PostgreSQL' when the DB call fails", async () => {
    vi.mocked(bazaarDb.getBazaarStats).mockRejectedValueOnce(new Error("connection refused"));

    const res = await app.inject({ method: "GET", url: "/api/v1/bazaar/stats" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data_source).not.toBe("PostgreSQL");
  });

  it("reports data_source: 'static-fallback' when the DB call fails", async () => {
    vi.mocked(bazaarDb.getBazaarStats).mockRejectedValueOnce(new Error("connection refused"));

    const res = await app.inject({ method: "GET", url: "/api/v1/bazaar/stats" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data_source).toBe("static-fallback");
  });

  it("includes degraded: true when the fallback runs", async () => {
    vi.mocked(bazaarDb.getBazaarStats).mockRejectedValueOnce(new Error("DB down"));

    const res = await app.inject({ method: "GET", url: "/api/v1/bazaar/stats" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.degraded).toBe(true);
  });

  it("does NOT include degraded when the DB call succeeds", async () => {
    vi.mocked(bazaarDb.getBazaarStats).mockResolvedValueOnce({
      total_intents: 1, active_intents: 1, negotiating_intents: 0,
      executed_intents: 0, expired_intents: 0, total_volume_usdc: 0,
      total_broadcasts: 1, total_swaps_completed: 0, total_swaps_cancelled: 0,
      top_agents: [], recent_intents: [],
    } as any);

    const res = await app.inject({ method: "GET", url: "/api/v1/bazaar/stats" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.degraded).toBeUndefined();
  });

  it("fallback still returns a valid stats shape", async () => {
    vi.mocked(bazaarDb.getBazaarStats).mockRejectedValueOnce(new Error("DB down"));

    const res = await app.inject({ method: "GET", url: "/api/v1/bazaar/stats" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.total_intents).toBe("number");
    expect(typeof body.total_volume_usdc).toBe("number");
    expect(body.top_agents).toBeInstanceOf(Array);
    expect(body.recent_intents).toBeInstanceOf(Array);
    expect(body.network).toBe("global-intent-layer");
    expect(body.queried_at).toBeDefined();
  });
});
