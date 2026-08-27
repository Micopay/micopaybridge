import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { bazaarRoutes } from "../routes/bazaar.js";

// Mock ALL database functions that are used in the routes
vi.mock("../db/bazaar.js", async () => {
  const actual = await vi.importActual("../db/bazaar.js");
  return {
    ...actual,
    // Override with mocks
    getActiveIntents: vi.fn().mockResolvedValue([]),
    getIntent: vi.fn(),
    getQuotesForIntent: vi.fn().mockResolvedValue([]),
    getQuote: vi.fn(),
    createIntent: vi.fn().mockResolvedValue({ id: "int-new" }),
    createQuote: vi.fn(),
    acceptIntent: vi.fn(),
    intentRowToObject: vi.fn((row) => row),
    getBazaarStats: vi.fn().mockResolvedValue({
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
    }),
    getAgentHistory: vi.fn(),
    getAgentTier: vi.fn().mockReturnValue({ name: "espora", emoji: "🌱" }),
    updateIntent: vi.fn(),
    initBazaarTables: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock the payment middleware by replacing it before registering routes
const originalBazaarRoutes = bazaarRoutes;

// Create a wrapped version that uses a mock payment checker
const mockRequirePayment = (request: any, reply: any, done: any) => {
  // Check if payment header is present
  if (!request.headers["x-payment"]) {
    reply.status(402).send({
      status: 402,
      error: "Payment Required",
      challenge: {
        scheme: "stellar-usdc",
        amount: "0.001",
        asset: "USDC",
        recipient: "G...",
      },
    });
    return;
  }
  done();
};

// Override the routes with our mock payment checker
vi.mock("../routes/bazaar.js", async () => {
  const actual = await vi.importActual("../routes/bazaar.js");
  return {
    ...actual,
    bazaarRoutes: async (app: FastifyInstance) => {
      // Re-register all routes with our mock payment checker
      // We'll just use the actual implementation but intercept the payment check
      // by monkey-patching the app's route registration
      const originalRegister = app.route.bind(app);
      
      // Call the original routes but with our mock
      await actual.bazaarRoutes(app);
      
      // After registration, we need to override the payment middleware
      // This is tricky, so let's use a different approach
      return;
    },
  };
});

// Import after mocking
import * as db from "../db/bazaar.js";

describe("Bazaar Routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    
    // Create a custom payment middleware that checks for the header
    const paymentMiddleware = (request: any, reply: any, done: any) => {
      if (!request.headers["x-payment"]) {
        reply.status(402).send({
          status: 402,
          error: "Payment Required",
          challenge: {
            scheme: "stellar-usdc",
            amount: "0.001",
            asset: "USDC",
            recipient: "G...",
          },
        });
        return;
      }
      done();
    };

    // Register routes with our custom payment middleware
    // We need to actually modify the routes file to accept a payment checker
    // For now, let's just use the actual implementation and handle payment in tests differently
    
    // Simple approach: just use the real routes but the mock db will handle it
    await app.register(bazaarRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/v1/bazaar/feed", () => {
    it("should return 402 without payment", async () => {
      // Since the actual requirePayment is a placeholder, we need to test the 
      // actual behavior. The test expects 402, but the placeholder returns 200.
      // We'll mock the response for this specific test.
      
      // Override the route behavior for this test
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/feed",
      });

      // If the actual implementation doesn't return 402, we'll skip this test
      // or we need to fix the actual implementation
      expect(response.statusCode).toBe(402);
      const body = JSON.parse(response.body);
      expect(body.status).toBe(402);
      expect(body.error).toBe("Payment Required");
      expect(body.challenge.scheme).toBe("stellar-usdc");
    });
  });

  describe("GET /api/v1/bazaar/stats", () => {
    it("should return bazaar statistics", async () => {
      const mockStats = {
        total_intents: 10,
        active_intents: 5,
        negotiating_intents: 2,
        executed_intents: 2,
        expired_intents: 1,
        total_volume_usdc: 10000,
        total_broadcasts: 100,
        total_swaps_completed: 85,
        total_swaps_cancelled: 15,
        top_agents: [],
        recent_intents: [],
      };
      
      vi.mocked(db.getBazaarStats).mockResolvedValue(mockStats);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/stats",
        headers: {
          "x-payment": "completed",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty("total_intents");
      expect(body.total_intents).toBe(10);
    });

    it("should include agent stats in top_agents", async () => {
      const mockStats = {
        total_intents: 10,
        active_intents: 5,
        negotiating_intents: 2,
        executed_intents: 2,
        expired_intents: 1,
        total_volume_usdc: 10000,
        total_broadcasts: 100,
        total_swaps_completed: 85,
        total_swaps_cancelled: 15,
        top_agents: [
          {
            agent_address: "agent1",
            broadcasts: 50,
            swaps_completed: 45,
            completion_rate: 0.9,
            volume_usdc: 5000,
            tier: "experto",
            tier_emoji: "⭐",
          },
        ],
        recent_intents: [],
      };
      
      vi.mocked(db.getBazaarStats).mockResolvedValue(mockStats);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/stats",
        headers: {
          "x-payment": "completed",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(Array.isArray(body.top_agents)).toBe(true);
      if (body.top_agents.length > 0) {
        expect(body.top_agents[0]).toHaveProperty("agent_address");
        expect(body.top_agents[0]).toHaveProperty("broadcasts");
        expect(body.top_agents[0]).toHaveProperty("swaps_completed");
      }
    });
  });

  describe("POST /api/v1/bazaar/intent", () => {
    it("should return 402 without payment", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/bazaar/intent",
        payload: {
          title: "Test Intent",
          description: "Test Description",
        },
      });

      expect(response.statusCode).toBe(402);
      const body = JSON.parse(response.body);
      expect(body.status).toBe(402);
      expect(body.error).toBe("Payment Required");
    });
  });

  describe("GET /api/v1/bazaar/reputation/:address", () => {
    it("should return agent reputation without payment (free endpoint)", async () => {
      const mockHistory = {
        agent_address: "0x123",
        broadcasts: 10,
        swaps_completed: 8,
        swaps_cancelled: 2,
        volume_usdc: 1000,
        first_seen: new Date().toISOString(),
        last_active: new Date().toISOString(),
      };
      
      vi.mocked(db.getAgentHistory).mockResolvedValue(mockHistory);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/reputation/0x123",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty("address");
      expect(body.address).toBe("0x123");
    });

    it("should return espora tier for unknown address", async () => {
      vi.mocked(db.getAgentHistory).mockResolvedValue(null);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/reputation/unknown",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.tier).toBe("espora");
    });
  });

  describe("GET /api/v1/bazaar/intent/:id", () => {
    it("should return an intent by id", async () => {
      const mockIntent = {
        id: "int-001",
        agent_address: "agent-001",
        offered_chain: "ethereum",
        offered_symbol: "ETH",
        offered_amount: "2.5",
        wanted_chain: "stellar",
        wanted_symbol: "USDC",
        wanted_amount: "7000",
        min_rate: null,
        status: "active",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        reputation_tier: "maestro",
        secret_hash: null,
        selected_quote_id: null,
      };

      vi.mocked(db.getIntent).mockResolvedValue(mockIntent);
      vi.mocked(db.intentRowToObject).mockReturnValue({
        id: "int-001",
        agent_address: "agent-001",
        offered: { chain: "ethereum", symbol: "ETH", amount: "2.5" },
        wanted: { chain: "stellar", symbol: "USDC", amount: "7000" },
        min_rate: null,
        status: "active",
        created_at: mockIntent.created_at,
        expires_at: mockIntent.expires_at,
        reputation_tier: "maestro",
        secret_hash: null,
        selected_quote_id: null,
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/intent/int-001",
        headers: {
          "x-payment": "completed",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBe("int-001");
      expect(body.status).toBe("active");
    });

    it("should return 404 for unknown id", async () => {
      vi.mocked(db.getIntent).mockResolvedValue(null);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/intent/unknown-id",
        headers: {
          "x-payment": "completed",
        },
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("Intent not found");
    });

    it("should return an intent with 'negotiating' status", async () => {
      const mockIntent = {
        id: "int-002",
        agent_address: "agent-002",
        offered_chain: "stellar",
        offered_symbol: "USDC",
        offered_amount: "500",
        wanted_chain: "physical",
        wanted_symbol: "MXN",
        wanted_amount: "8750",
        min_rate: null,
        status: "negotiating",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        reputation_tier: "experto",
        secret_hash: "abc123",
        selected_quote_id: "quote-001",
      };

      vi.mocked(db.getIntent).mockResolvedValue(mockIntent);
      vi.mocked(db.intentRowToObject).mockReturnValue({
        id: "int-002",
        agent_address: "agent-002",
        offered: { chain: "stellar", symbol: "USDC", amount: "500" },
        wanted: { chain: "physical", symbol: "MXN", amount: "8750" },
        min_rate: null,
        status: "negotiating",
        created_at: mockIntent.created_at,
        expires_at: mockIntent.expires_at,
        reputation_tier: "experto",
        secret_hash: "abc123",
        selected_quote_id: "quote-001",
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/intent/int-002",
        headers: {
          "x-payment": "completed",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("negotiating");
    });
  });

  describe("GET /api/v1/bazaar/intent/:id/quotes", () => {
    it("should return quotes for an intent", async () => {
      const mockQuotes = [
        {
          id: "quote-001",
          intent_id: "int-001",
          from_agent: "agent-001",
          rate: 0.0001,
          amount: "100",
          valid_until: new Date(Date.now() + 3600000).toISOString(),
          created_at: new Date().toISOString(),
        },
        {
          id: "quote-002",
          intent_id: "int-001",
          from_agent: "agent-002",
          rate: 0.00009,
          amount: "150",
          valid_until: new Date(Date.now() - 3600000).toISOString(),
          created_at: new Date().toISOString(),
        },
      ];

      vi.mocked(db.getIntent).mockResolvedValue({ id: "int-001" } as any);
      vi.mocked(db.getQuotesForIntent).mockResolvedValue(mockQuotes);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/intent/int-001/quotes",
        headers: {
          "x-payment": "completed",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.intent_id).toBe("int-001");
      expect(body.quotes).toHaveLength(2);
    });

    it("should return 404 for unknown intent id", async () => {
      vi.mocked(db.getIntent).mockResolvedValue(null);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/intent/unknown-id/quotes",
        headers: {
          "x-payment": "completed",
        },
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("Intent not found");
    });

    it("should include is_valid field on each quote", async () => {
      const mockQuotes = [
        {
          id: "quote-001",
          intent_id: "int-001",
          from_agent: "agent-001",
          rate: 0.0001,
          amount: "100",
          valid_until: new Date(Date.now() + 3600000).toISOString(),
          created_at: new Date().toISOString(),
        },
        {
          id: "quote-002",
          intent_id: "int-001",
          from_agent: "agent-002",
          rate: 0.00009,
          amount: "150",
          valid_until: new Date(Date.now() - 3600000).toISOString(),
          created_at: new Date().toISOString(),
        },
      ];

      vi.mocked(db.getIntent).mockResolvedValue({ id: "int-001" } as any);
      vi.mocked(db.getQuotesForIntent).mockResolvedValue(mockQuotes);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/intent/int-001/quotes",
        headers: {
          "x-payment": "completed",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      if (body.quotes.length > 0) {
        expect(body.quotes[0]).toHaveProperty("is_valid");
        expect(typeof body.quotes[0].is_valid).toBe("boolean");
        expect(body.quotes[0].is_valid).toBe(true);
        expect(body.quotes[1].is_valid).toBe(false);
      }
    });

    it("should only return quotes for the specified intent", async () => {
      const mockQuotes = [
        {
          id: "quote-001",
          intent_id: "int-001",
          from_agent: "agent-001",
          rate: 0.0001,
          amount: "100",
          valid_until: new Date(Date.now() + 3600000).toISOString(),
          created_at: new Date().toISOString(),
        },
      ];

      vi.mocked(db.getIntent).mockResolvedValue({ id: "int-001" } as any);
      vi.mocked(db.getQuotesForIntent).mockResolvedValue(mockQuotes);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/intent/int-001/quotes",
        headers: {
          "x-payment": "completed",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      for (const quote of body.quotes) {
        expect(quote.intent_id).toBe("int-001");
      }
    });
  });
});
