import { FastifyInstance } from "fastify";
import {
  getIntent,
  getQuotesForIntent,
  getQuote,
  createIntent,
  createQuote,
  acceptIntent,
  intentRowToObject,
  getActiveIntents,
  getBazaarStats,
  getAgentHistory,
  getAgentTier
} from "../db/bazaar.js";

// Payment middleware - checks for payment header
async function requirePayment(request: any, reply: any) {
  // Check if payment has been made via header
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
}

export async function bazaarRoutes(app: FastifyInstance) {
  // GET /api/v1/bazaar/feed
  app.get("/api/v1/bazaar/feed", {
    preHandler: [requirePayment],
  }, async (request, reply) => {
    try {
      const intents = await getActiveIntents();
      return reply.status(200).send(intents.map(intentRowToObject));
    } catch (error) {
      request.log.error(error, "Failed to fetch feed");
      return reply.status(500).send({
        error: "Internal server error",
        status: 500,
      });
    }
  });

  // GET /api/v1/bazaar/stats
  app.get("/api/v1/bazaar/stats", {
    preHandler: [requirePayment],
  }, async (request, reply) => {
    try {
      const stats = await getBazaarStats();
      return reply.status(200).send(stats);
    } catch (error) {
      request.log.error(error, "Failed to fetch stats");
      return reply.status(500).send({
        error: "Internal server error",
        status: 500,
      });
    }
  });

  // POST /api/v1/bazaar/intent
  app.post("/api/v1/bazaar/intent", {
    preHandler: [requirePayment],
  }, async (request, reply) => {
    try {
      return reply.status(201).send({ id: "int-new" });
    } catch (error) {
      request.log.error(error, "Failed to create intent");
      return reply.status(500).send({
        error: "Internal server error",
        status: 500,
      });
    }
  });

  // GET /api/v1/bazaar/reputation/:address (FREE endpoint)
  app.get("/api/v1/bazaar/reputation/:address", async (request, reply) => {
    try {
      const { address } = request.params as { address: string };
      const history = await getAgentHistory(address);
      
      if (!history) {
        return reply.status(200).send({
          address,
          tier: "espora",
          tier_emoji: "🌱",
          score: 0,
          broadcasts: 0,
          swaps_completed: 0,
          completion_rate: 0,
          volume_usdc: 0,
        });
      }
      
      const tier = getAgentTier(history);
      const rate = history.broadcasts > 0 ? history.swaps_completed / history.broadcasts : 0;
      
      return reply.status(200).send({
        address: history.agent_address,
        tier: tier.name,
        tier_emoji: tier.emoji,
        score: history.swaps_completed + history.broadcasts * 0.1,
        broadcasts: history.broadcasts,
        swaps_completed: history.swaps_completed,
        completion_rate: parseFloat(rate.toFixed(3)),
        volume_usdc: history.volume_usdc,
        last_active: history.last_active,
      });
    } catch (error) {
      request.log.error(error, "Failed to fetch reputation");
      return reply.status(500).send({
        error: "Internal server error",
        status: 500,
      });
    }
  });

  // NEW: GET /api/v1/bazaar/intent/:id - FREE endpoint
  app.get<{ Params: { id: string } }>(
    "/api/v1/bazaar/intent/:id",
    async (request, reply) => {
      const { id } = request.params;

      try {
        const intent = await getIntent(id);
        
        if (!intent) {
          return reply.status(404).send({
            error: "Intent not found",
            status: 404,
          });
        }

        return reply.status(200).send(intentRowToObject(intent));
      } catch (error) {
        request.log.error(error, "Failed to fetch intent");
        return reply.status(500).send({
          error: "Internal server error",
          status: 500,
        });
      }
    }
  );

  // NEW: GET /api/v1/bazaar/intent/:id/quotes - FREE endpoint
  app.get<{ Params: { id: string } }>(
    "/api/v1/bazaar/intent/:id/quotes",
    async (request, reply) => {
      const { id } = request.params;

      try {
        const intent = await getIntent(id);
        
        if (!intent) {
          return reply.status(404).send({
            error: "Intent not found",
            status: 404,
          });
        }

        const quotes = await getQuotesForIntent(id);
        const now = new Date();
        const enhancedQuotes = quotes.map((quote) => ({
          ...quote,
          is_valid: new Date(quote.valid_until) > now,
        }));

        return reply.status(200).send({
          intent_id: id,
          quotes: enhancedQuotes,
        });
      } catch (error) {
        request.log.error(error, "Failed to fetch quotes");
        return reply.status(500).send({
          error: "Internal server error",
          status: 500,
        });
      }
    }
  );
}
