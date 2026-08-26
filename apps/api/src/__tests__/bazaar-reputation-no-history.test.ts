/**
 * BRIDGE-16: /reputation/:address must be self-describing for agents with no
 * history, and must not serve invented figures when the DB is unavailable.
 *
 * Three cases tested:
 *   1. Agent not seen in DB   → no_history:true, reason:"agent_not_seen"  (200)
 *   2. DB unavailable         → no_history:true, reason:"database_unavailable" (503)
 *   3. Agent with history     → full reputation object, no_history:false  (200)
 *
 * All tests run offline — no Postgres, no Stellar.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

// ── Stable history fixture used in case 3 ───────────────────────────────────
const KNOWN_ADDRESS = "GKNOWN00000000000000000000000000000000000000000000000001";
const UNKNOWN_ADDRESS = "GUNKNOWN0000000000000000000000000000000000000000000000001";

const knownHistory = {
  agent_address: KNOWN_ADDRESS,
  broadcasts: 10,
  swaps_completed: 8,
  swaps_cancelled: 2,
  volume_usdc: 3200,
  first_seen: "2026-01-01T00:00:00.000Z",
  last_active: "2026-08-01T00:00:00.000Z",
};

// ── Mock: getAgentHistory returns null for UNKNOWN, throws for DB_DOWN ───────
const DB_DOWN_ADDRESS = "GDBDOWN000000000000000000000000000000000000000000000000001";

vi.mock("../db/bazaar.js", () => ({
  initBazaarTables: vi.fn(async () => {}),
  seedIntents: vi.fn(async () => {}),
  createIntent: vi.fn(),
  getIntent: vi.fn(),
  getActiveIntents: vi.fn(async () => []),
  updateIntent: vi.fn(),
  createQuote: vi.fn(),
  getQuote: vi.fn(),
  getQuotesForIntent: vi.fn(async () => []),
  getAgentHistory: vi.fn(async (address: string) => {
    if (address === DB_DOWN_ADDRESS) {
      throw new Error("connection refused");
    }
    if (address === KNOWN_ADDRESS) {
      return { ...knownHistory };
    }
    return null; // agent not seen
  }),
  upsertAgentHistory: vi.fn(async (_address: string, _delta: unknown) => knownHistory),
  intentRowToObject: (row: unknown) => row,
  getBazaarStats: vi.fn(async () => ({
    total_intents: 0,
    active_intents: 0,
    negotiating_intents: 0,
    executed_intents: 0,
    expired_intents: 0,
    total_volume_usdc: 0,
    total_broadcasts: 0,
    total_swaps_completed: 0,
    total_swaps_cancelled: 0,
    top_agents: [],
    recent_intents: [],
  })),
}));

import { bazaarRoutes } from "../routes/bazaar.js";

describe("GET /api/v1/bazaar/reputation/:address — BRIDGE-16", () => {
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

  // ── Case 1: agent not seen ─────────────────────────────────────────────────
  describe("agent with no recorded history", () => {
    it("returns 200 with no_history:true and reason:agent_not_seen", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/bazaar/reputation/${UNKNOWN_ADDRESS}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.no_history).toBe(true);
      expect(body.reason).toBe("agent_not_seen");
      expect(body.address).toBe(UNKNOWN_ADDRESS);
      expect(body).toHaveProperty("message");
      expect(body.message).toMatch(/no recorded activity/i);
    });

    it("does not include agent_reputation or invented figures", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/bazaar/reputation/${UNKNOWN_ADDRESS}`,
      });

      const body = JSON.parse(res.body);

      // Must NOT carry a reputation block — that would imply computed numbers
      expect(body.agent_reputation).toBeUndefined();
      expect(body.agent_signal).toBeUndefined();

      // Must NOT carry any numeric swap counts
      expect(body.swaps_completed).toBeUndefined();
      expect(body.volume_usdc_total).toBeUndefined();
    });

    it("names the data source so the caller knows this is PostgreSQL, not a guess", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/bazaar/reputation/${UNKNOWN_ADDRESS}`,
      });

      const body = JSON.parse(res.body);
      expect(body.data_source).toMatch(/postgresql/i);
    });
  });

  // ── Case 2: DB unavailable ────────────────────────────────────────────────
  describe("DB unavailable (degraded path)", () => {
    it("returns 503 with no_history:true and reason:database_unavailable", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/bazaar/reputation/${DB_DOWN_ADDRESS}`,
      });

      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);

      expect(body.no_history).toBe(true);
      expect(body.reason).toBe("database_unavailable");
      expect(body.address).toBe(DB_DOWN_ADDRESS);
      expect(body).toHaveProperty("message");
    });

    it("does not serve invented figures when DB is down", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/bazaar/reputation/${DB_DOWN_ADDRESS}`,
      });

      const body = JSON.parse(res.body);

      // No numbers that could be mistaken for real history
      expect(body.agent_reputation).toBeUndefined();
      expect(body.agent_signal).toBeUndefined();
      expect(body.swaps_completed).toBeUndefined();
      expect(body.volume_usdc_total).toBeUndefined();

      // data_source must say unavailable, not "PostgreSQL" or "in-memory"
      expect(body.data_source).toBe("unavailable");
    });

    it("does not quietly fall back to zero-valued reputation for unknown address when DB is down", async () => {
      // This would be the old behaviour: silently return a reputation object
      // with all-zero fields, looking like a valid (if new) agent.
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/bazaar/reputation/${DB_DOWN_ADDRESS}`,
      });

      const body = JSON.parse(res.body);
      // Must be explicit about the problem, not pretend the agent is just new
      expect(body.reason).toBe("database_unavailable");
      expect(body.no_history).toBe(true);
    });
  });

  // ── Case 3: agent with real history ───────────────────────────────────────
  describe("agent with recorded history", () => {
    it("returns 200 with no_history:false and a full reputation block", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/bazaar/reputation/${KNOWN_ADDRESS}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.no_history).toBe(false);
      expect(body.address).toBe(KNOWN_ADDRESS);
      expect(body.agent_reputation).toBeDefined();
      expect(body.agent_reputation.swaps_completed).toBe(8);
      expect(body.agent_reputation.total_broadcasts).toBe(10);
    });

    it("computes completion_rate from real history, not seeded data", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/bazaar/reputation/${KNOWN_ADDRESS}`,
      });

      const body = JSON.parse(res.body);
      // 8 completed / 10 broadcasts = 0.800
      expect(body.agent_reputation.completion_rate).toBe(0.8);
      expect(body.agent_reputation.completion_percent).toBe("80.0%");
    });

    it("classifies tier based on actual history (activo: ≥3 swaps, ≥75% rate)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/bazaar/reputation/${KNOWN_ADDRESS}`,
      });

      const body = JSON.parse(res.body);
      // 8 swaps, 80% rate → activo (≥3 swaps, ≥75%; below experto threshold of 15 swaps)
      expect(body.agent_reputation.tier).toBe("activo");
    });
  });
});

// ── /stats degraded path: must return zeros, not seeded agents ───────────────
describe("GET /api/v1/bazaar/stats — degraded DB path (BRIDGE-16)", () => {
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

  it("returns empty top_agents when DB is unavailable — no invented agents", async () => {
    // Override getBazaarStats to throw
    const { getBazaarStats } = await import("../db/bazaar.js");
    vi.mocked(getBazaarStats).mockRejectedValueOnce(new Error("connection refused"));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/bazaar/stats",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.degraded).toBe(true);
    expect(body.data_source).toBe("static-fallback");
    expect(body.top_agents).toEqual([]);
    expect(body.total_volume_usdc).toBe(0);
    expect(body.total_swaps_completed).toBe(0);
  });

  it("does not include the two seeded addresses in top_agents when DB is down", async () => {
    const { getBazaarStats } = await import("../db/bazaar.js");
    vi.mocked(getBazaarStats).mockRejectedValueOnce(new Error("connection refused"));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/bazaar/stats",
    });

    const body = JSON.parse(res.body);
    const addresses = (body.top_agents as Array<{ agent_address: string }>).map(a => a.agent_address);

    expect(addresses).not.toContain("GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG");
    expect(addresses).not.toContain("GDFJHLAXAUMHA4OWPOB4P7YO72AQR2HMIUYFOXLXE2DZGM633K7HZDQP");
  });
});
