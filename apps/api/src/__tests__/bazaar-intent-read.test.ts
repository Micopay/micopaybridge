import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { bazaarRoutes } from "../routes/bazaar.js";
import * as db from "../db/bazaar.js";

vi.mock("../db/bazaar.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual as any,
    getIntent: vi.fn(),
    getQuotesForIntent: vi.fn(),
    initBazaarTables: vi.fn().mockResolvedValue(undefined),
    seedAgentHistories: vi.fn().mockResolvedValue(undefined),
    seedIntents: vi.fn().mockResolvedValue(undefined),
  };
});

describe("Bazaar Intent Read Endpoints", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(bazaarRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /api/v1/bazaar/intent/:id", () => {
    it("should return 404 for unknown intent", async () => {
      vi.mocked(db.getIntent).mockResolvedValueOnce(null);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/intent/nonexistent-id",
      });
      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error).toBe("Intent not found");
    });

    it("should return the intent formatted properly", async () => {
      vi.mocked(db.getIntent).mockResolvedValueOnce({
        id: "int-001",
        agent_address: "GTEST",
        offered_chain: "eth",
        offered_symbol: "ETH",
        offered_amount: "1",
        wanted_chain: "xlm",
        wanted_symbol: "USDC",
        wanted_amount: "1",
        min_rate: null,
        status: "active",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        reputation_tier: "espora",
        secret_hash: null,
        selected_quote_id: null,
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/intent/int-001",
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBe("int-001");
      expect(body.agent_address).toBeDefined();
      expect(body.offered).toBeDefined();
      expect(body.wanted).toBeDefined();
    });
  });

  describe("GET /api/v1/bazaar/intent/:id/quotes", () => {
    it("should return 404 for quotes on unknown intent", async () => {
      vi.mocked(db.getIntent).mockResolvedValueOnce(null);
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/intent/nonexistent-id/quotes",
      });
      expect(response.statusCode).toBe(404);
    });

    it("should return quotes with correct is_expired flag", async () => {
      const intentId = "int-test-1234";

      vi.mocked(db.getIntent).mockResolvedValueOnce({
        id: intentId,
      } as any);

      vi.mocked(db.getQuotesForIntent).mockResolvedValueOnce([
        {
          id: "qut-active",
          intent_id: intentId,
          from_agent: "GAGENT1",
          rate: 1.0,
          valid_until: new Date(Date.now() + 3600_000).toISOString(),
          created_at: new Date().toISOString(),
        },
        {
          id: "qut-expired",
          intent_id: intentId,
          from_agent: "GAGENT2",
          rate: 0.9,
          valid_until: new Date(Date.now() - 3600_000).toISOString(),
          created_at: new Date().toISOString(),
        }
      ]);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/bazaar/intent/${intentId}/quotes`,
      });
      
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.intent_id).toBe(intentId);
      expect(body.quotes.length).toBe(2);

      const activeQuote = body.quotes.find((q: any) => q.from_agent === "GAGENT1");
      const expiredQuote = body.quotes.find((q: any) => q.from_agent === "GAGENT2");

      expect(activeQuote.is_expired).toBe(false);
      expect(expiredQuote.is_expired).toBe(true);
    });
  });
});
