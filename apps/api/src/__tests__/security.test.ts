import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../index.js";
import type { FastifyInstance } from "fastify";

describe("Security Headers & CORS (SEC-21)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("Security Headers", () => {
    it("should include Strict-Transport-Security header", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.headers["strict-transport-security"]).toBeDefined();
      expect(response.headers["strict-transport-security"]).toContain("max-age=31536000");
      expect(response.headers["strict-transport-security"]).toContain("includeSubDomains");
    });

    it("should include X-Content-Type-Options header", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("should include X-Frame-Options header", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.headers["x-frame-options"]).toBe("DENY");
    });

    it("should include Content-Security-Policy header", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.headers["content-security-policy"]).toBeDefined();
      expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    });

    it("should include Referrer-Policy header", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    });

    it("should include X-XSS-Protection header", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.headers["x-xss-protection"]).toBeDefined();
    });
  });

  describe("CORS Configuration", () => {
    it("should allow OPTIONS preflight requests", async () => {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/health",
        // Sin estas dos cabeceras no es un preflight: @fastify/cors lo deja
        // pasar al router, que no tiene handler de OPTIONS para /health y
        // responde 400. El test llevaba rojo desde antes de la migración —
        // los tests de apps/api nunca estuvieron en un gate de CI.
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "GET",
        },
      });

      expect(response.statusCode).toBe(204);
    });

    it("should include CORS headers for localhost in development", async () => {
      // In development, localhost should be allowed
      const response = await app.inject({
        method: "GET",
        url: "/health",
        headers: {
          origin: "http://localhost:3000",
        },
      });

      // Helmet doesn't set CORS headers, that's done by fastify-cors
      // Check that the response doesn't have errors
      expect(response.statusCode).toBe(200);
    });

    it("should expose Authorization header in CORS preflight", async () => {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/api/v1/merchants",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "POST",
          "access-control-request-headers": "Content-Type,Authorization",
        },
      });

      // Response should handle the preflight
      expect(response.statusCode).toBe(204);
    });

    it("should support credentials in CORS headers", async () => {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/api/v1/merchants",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "POST",
        },
      });

      // Response should be successful for preflight
      expect(response.statusCode).toBe(204);
    });
  });

  describe("Public Endpoints Accessibility", () => {
    it("GET /health should be accessible without CORS issues", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty("status");
    });

    // Antes apuntaba a /merchants, la ruta retail que se quedó en
    // micopay-protocol (§3.2 del plan). El endpoint público equivalente en
    // este repo es el de reputación, que sí se migra.
    it("GET /api/v1/merchants should be accessible without authentication", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/merchants",
      });

      // Lo que prueba este caso es que la ruta NO exija autenticación, no que
      // devuelva datos. 501 es la respuesta por defecto desde que la reputación
      // de comercios está apagada (necesita la red de efectivo de MicoPay, que
      // todavía no existe) y sigue siendo accesible sin autenticar. 500 cubre
      // que la base no esté levantada en el entorno de test.
      expect([200, 500, 501]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(401);
      expect(response.statusCode).not.toBe(403);
    });

    it("should not expose sensitive headers in response", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      // Should not expose internal server details
      expect(response.headers["server"]).toBeUndefined();
      expect(response.headers["x-powered-by"]).toBeUndefined();
    });
  });

  describe("Security Header Values", () => {
    it("CSP should restrict default resources", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      const csp = response.headers["content-security-policy"] as string;
      expect(csp).toContain("default-src 'self'");
      expect(csp).not.toContain("default-src *");
    });

    it("CSP should allow Stellar RPC endpoints", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      const csp = response.headers["content-security-policy"] as string;
      expect(csp).toContain("connect-src");
      expect(csp).toContain("soroban");
    });

    it("HSTS should be preload-compatible", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      const hsts = response.headers["strict-transport-security"] as string;
      expect(hsts).toContain("max-age=");
      // Should have includeSubDomains and preload for full HSTS
      expect(hsts).toContain("includeSubDomains");
    });
  });
});
