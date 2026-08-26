import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { bazaarRoutes } from "../routes/bazaar.js";

describe("Bazaar Routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(bazaarRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /api/v1/bazaar/feed", () => {
    it("should return 402 without payment", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/feed",
      });

      expect(response.statusCode).toBe(402);
      const body = JSON.parse(response.body);
      expect(body.status).toBe(402);
      expect(body.error).toBe("Payment Required");
      expect(body.challenge.scheme).toBe("stellar-usdc");
    });
  });

  describe("GET /api/v1/bazaar/stats", () => {
    it("should return bazaar statistics", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/stats",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.total_intents).toBeDefined();
      expect(body.active_intents).toBeDefined();
      expect(body.total_volume_usdc).toBeDefined();
      expect(body.top_agents).toBeInstanceOf(Array);
      expect(body.recent_intents).toBeInstanceOf(Array);
      expect(body.network).toBe("global-intent-layer");
      expect(body.queried_at).toBeDefined();
    });

    it("should include agent stats in top_agents when DB is available", async () => {
      // When the DB is unavailable (offline tests), top_agents is [] — that is
      // the honest degraded response. The shape contract (each item has the
      // required fields) is verified by the no-history test suite.
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/stats",
      });

      const body = JSON.parse(response.body);
      // top_agents must be an array (possibly empty when DB is offline).
      // The old test demanded length > 0, which was only true because of
      // seeded figures. Seeded figures are gone; offline tests get [].
      expect(body.top_agents).toBeInstanceOf(Array);
      // If any agents are present, they must have the expected shape.
      if (body.top_agents.length > 0) {
        const agent = body.top_agents[0];
        expect(agent.agent_address).toBeDefined();
        expect(agent.broadcasts).toBeDefined();
        expect(agent.swaps_completed).toBeDefined();
        expect(agent.completion_rate).toBeDefined();
        expect(agent.volume_usdc).toBeDefined();
        expect(agent.tier).toBeDefined();
      }
    });
  });

  describe("POST /api/v1/bazaar/intent", () => {
    it("should return 402 without payment", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/bazaar/intent",
        payload: {
          offered: { chain: "ethereum", symbol: "ETH", amount: "1.0" },
          wanted: { chain: "stellar", symbol: "USDC", amount: "2800" },
        },
      });

      expect(response.statusCode).toBe(402);
    });
  });

  describe("GET /api/v1/bazaar/reputation/:address", () => {
    it("should return reputation without payment (free endpoint)", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/reputation/GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG",
      });

      // Either 200 (no history / full reputation) or 503 (DB unavailable).
      // Both are valid offline responses. What is NOT valid is a 5xx that
      // crashes the route or a response missing the no_history discriminant.
      expect([200, 503]).toContain(response.statusCode);
      const body = JSON.parse(response.body);
      expect(body.address).toBe("GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG");
      // no_history must always be present so callers can branch without guessing.
      expect(typeof body.no_history).toBe("boolean");
    });

    it("should return no_history:true for an unknown address (DB unavailable offline = 503)", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/reputation/GUNKNOWNTESTADDRESS123456789012345678901234567890",
      });

      // Offline (no DB): the route cannot distinguish "not seen" from "DB down",
      // so it returns 503 with no_history:true and reason:database_unavailable.
      // The old test expected 200 + espora tier, which required seeded data.
      expect([200, 503]).toContain(response.statusCode);
      const body = JSON.parse(response.body);
      expect(body.no_history).toBe(true);
      // Must NOT carry an invented agent_reputation block.
      expect(body.agent_reputation).toBeUndefined();
    });
  });
});
