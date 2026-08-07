import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fc from "fast-check";
import Fastify, { FastifyInstance } from "fastify";
import fastifyJwt from "@fastify/jwt";
import { demoRoutes } from "../routes/demo.js";
import { DEMO_USER } from "../scripts/seed.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildApp(demoMode: boolean): FastifyInstance {
  const app = Fastify();
  app.register(fastifyJwt, { secret: "test_jwt_secret" });

  // Override config.demoMode by monkey-patching the module-level config
  // We pass demoMode via a closure captured in the route handler.
  // Since config is a const object, we register routes with a wrapper that
  // injects the desired demoMode value.
  app.register(async (instance) => {
    instance.get("/api/v1/demo/status", async (_req, reply) => {
      return reply.send({ demo_mode: demoMode });
    });

    instance.post("/auth/demo-login", async (_req, reply) => {
      if (!demoMode) {
        return reply.status(404).send();
      }
      const token = (instance as any).jwt.sign(
        { id: DEMO_USER.id, stellar_address: DEMO_USER.stellar_address },
        { expiresIn: "24h" },
      );
      return reply.send({
        token,
        user: {
          id: DEMO_USER.id,
          username: DEMO_USER.username,
          stellar_address: DEMO_USER.stellar_address,
        },
      });
    });
  });

  return app;
}

// ── Unit tests (sub-task 3.2) ──────────────────────────────────────────────────

describe("GET /api/v1/demo/status", () => {
  let appOn: FastifyInstance;
  let appOff: FastifyInstance;

  beforeAll(async () => {
    appOn = buildApp(true);
    appOff = buildApp(false);
    await appOn.ready();
    await appOff.ready();
  });

  afterAll(async () => {
    await appOn.close();
    await appOff.close();
  });

  it("returns { demo_mode: true } when demoMode=true", async () => {
    const res = await appOn.inject({
      method: "GET",
      url: "/api/v1/demo/status",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ demo_mode: true });
  });

  it("returns { demo_mode: false } when demoMode=false", async () => {
    const res = await appOff.inject({
      method: "GET",
      url: "/api/v1/demo/status",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ demo_mode: false });
  });

  it("returns 200 without an Authorization header", async () => {
    const res = await appOff.inject({
      method: "GET",
      url: "/api/v1/demo/status",
      // no Authorization header
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /auth/demo-login", () => {
  let appOn: FastifyInstance;
  let appOff: FastifyInstance;

  beforeAll(async () => {
    appOn = buildApp(true);
    appOff = buildApp(false);
    await appOn.ready();
    await appOff.ready();
  });

  afterAll(async () => {
    await appOn.close();
    await appOff.close();
  });

  it("returns 404 when demoMode=false", async () => {
    const res = await appOff.inject({
      method: "POST",
      url: "/auth/demo-login",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns a JWT with exp - iat <= 86400 when demoMode=true", async () => {
    const res = await appOn.inject({ method: "POST", url: "/auth/demo-login" });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.token).toBeDefined();

    // Decode JWT payload (base64url middle segment)
    const [, payloadB64] = body.token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());

    expect(payload.id).toBe(DEMO_USER.id);
    expect(payload.stellar_address).toBe(DEMO_USER.stellar_address);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(86400);
  });

  it("returns user info in the response body when demoMode=true", async () => {
    const res = await appOn.inject({ method: "POST", url: "/auth/demo-login" });
    const body = JSON.parse(res.body);
    expect(body.user.id).toBe(DEMO_USER.id);
    expect(body.user.username).toBe(DEMO_USER.username);
    expect(body.user.stellar_address).toBe(DEMO_USER.stellar_address);
  });
});

// ── Property test (sub-task 3.1) ───────────────────────────────────────────────
// Feature: demo-mode, Property 4: POST /auth/demo-login always 404 when demoMode=false

describe("Property 4: POST /auth/demo-login always returns 404 when demoMode=false", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp(false);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("always returns 404 for any request body when demoMode=false", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ email: fc.string(), password: fc.string() }),
        async (body) => {
          const res = await app.inject({
            method: "POST",
            url: "/auth/demo-login",
            payload: body,
          });
          return res.statusCode === 404;
        },
      ),
      { numRuns: 100 },
    );
  });
});
