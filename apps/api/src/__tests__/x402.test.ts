import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { requirePayment } from "../middleware/x402.js";

describe("x402 Middleware", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.get("/test", {
      preHandler: requirePayment({ amount: "0.001", service: "test" }),
    }, async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("without payment header", () => {
    it("should return 402 Payment Required", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/test",
      });

      expect(response.statusCode).toBe(402);
      const body = JSON.parse(response.body);
      expect(body.status).toBe(402);
      expect(body.error).toBe("Payment Required");
      expect(body.challenge).toBeDefined();
      expect(body.challenge.scheme).toBe("stellar-usdc");
      expect(body.challenge.amount_usdc).toBe("0.001");
    });

    it("should include payment instructions with memo and time bounds requirements (BRIDGE-11)", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/test",
      });

      const body = JSON.parse(response.body);
      expect(body.challenge.instructions).toBeDefined();
      expect(body.challenge.instructions).toContain("memo");
      expect(body.challenge.instructions).toContain("time bounds");
      expect(body.challenge.memo).toBe("micopay:test");
    });
  });

  describe("with mock payment", () => {
    const originalMockMode = process.env.X402_MOCK_MODE;

    beforeAll(() => {
      process.env.X402_MOCK_MODE = "true";
    });

    afterAll(() => {
      if (originalMockMode === undefined) delete process.env.X402_MOCK_MODE;
      else process.env.X402_MOCK_MODE = originalMockMode;
    });

    it("should accept mock payment header", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/test",
        headers: {
          "x-payment": "mock:GTEST123:0.001",
        },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe("with mock payment but X402_MOCK_MODE unset (SEC-C2 regression)", () => {
    const originalMockMode = process.env.X402_MOCK_MODE;

    // Borrarla explícitamente: un .env local con X402_MOCK_MODE=true hacía
    // que este test pasara en CI y fallara en la máquina del desarrollador.
    beforeAll(() => {
      delete process.env.X402_MOCK_MODE;
    });

    afterAll(() => {
      if (originalMockMode === undefined) delete process.env.X402_MOCK_MODE;
      else process.env.X402_MOCK_MODE = originalMockMode;
    });

    it("should reject the mock payment header", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/test",
        headers: {
          "x-payment": "mock:GTEST123:0.001",
        },
      });

      expect(response.statusCode).toBe(402);
    });
  });
});
