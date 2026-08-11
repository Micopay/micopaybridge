import type { FastifyInstance } from "fastify";
import { checkHealth } from "../services/health.js";
import { config } from "../config.js";

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { detailed?: string } }>(
    "/health",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const isDetailed = request.query.detailed === "true";

      if (isDetailed) {
        const health = await checkHealth();
        const statusCode =
          health.status === "healthy"
            ? 200
            : health.status === "degraded"
              ? 200
              : 503;
        return reply.status(statusCode).send(health);
      }

      return reply.send({
        status: "ok",
        service: "micopay-protocol-api",
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        payment_method: "x402",
        network: process.env.STELLAR_NETWORK ?? "testnet",
        detailed: "/health?detailed=true",
        features: {
          investments: config.enableInvestments,
        },
      });
    },
  );

  fastify.get("/health/live", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }));

  fastify.get("/health/ready", async (_request, reply) => {
    try {
      const health = await checkHealth();
      const isReady = health.status !== "unhealthy";
      return reply.status(isReady ? 200 : 503).send({
        status: isReady ? "ready" : "not_ready",
        components: health.components,
        timestamp: new Date().toISOString(),
      });
    } catch {
      return reply.status(503).send({
        status: "not_ready",
        error: "Health check failed",
        timestamp: new Date().toISOString(),
      });
    }
  });
}
