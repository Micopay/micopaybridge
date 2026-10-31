import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify from "fastify";

/**
 * /demo/run y /demo/run-zk gastan fondos del agente demo sin pago ni login.
 * Son demos de testnet: con STELLAR_NETWORK=PUBLIC responden 404 aunque haya
 * DEMO_AGENT_SECRET_KEY cargada.
 */

vi.mock("../db/schema.js", () => ({ query: vi.fn(async () => ({ rows: [] })) }));

async function post(network: string, url: string) {
  process.env.STELLAR_NETWORK = network;
  vi.resetModules();
  const { demoRoutes } = await import("../routes/demo.js");
  const app = Fastify();
  await app.register(demoRoutes);
  await app.ready();
  const res = await app.inject({ method: "POST", url });
  await app.close();
  return res;
}

describe("demo/run y demo/run-zk — solo testnet", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  for (const url of ["/api/v1/demo/run", "/api/v1/demo/run-zk"]) {
    it(`${url} responde 404 en mainnet aunque haya llave demo`, async () => {
      process.env.DEMO_AGENT_SECRET_KEY = "SDEMOKEYNOTREALXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
      const res = await post("PUBLIC", url);
      expect(res.statusCode).toBe(404);
    });

    it(`${url} en testnet sigue respondiendo (503 sin llave demo)`, async () => {
      delete process.env.DEMO_AGENT_SECRET_KEY;
      const res = await post("TESTNET", url);
      expect(res.statusCode).toBe(503);
    });
  }
});
