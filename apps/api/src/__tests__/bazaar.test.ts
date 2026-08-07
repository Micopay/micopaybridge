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

    it("should include agent stats in top_agents", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/stats",
      });

      const body = JSON.parse(response.body);
      expect(body.top_agents.length).toBeGreaterThan(0);
      const agent = body.top_agents[0];
      expect(agent.agent_address).toBeDefined();
      expect(agent.broadcasts).toBeDefined();
      expect(agent.swaps_completed).toBeDefined();
      expect(agent.completion_rate).toBeDefined();
      expect(agent.volume_usdc).toBeDefined();
      expect(agent.tier).toBeDefined();
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
    it("should return agent reputation without payment (free endpoint)", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/reputation/GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKUJI5KOOJ9TXWNTBBS2JN",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.agent_reputation).toBeDefined();
      expect(body.agent_reputation.tier).toBe("maestro");
      expect(body.agent_signal).toBeDefined();
    });

    it("should return espora tier for unknown address", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/reputation/GUNKNOWNTESTADDRESS123456789012345678901234567890",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.agent_reputation.tier).toBe("espora");
      expect(body.agent_signal.trusted).toBe(false);
    });
  });
});
