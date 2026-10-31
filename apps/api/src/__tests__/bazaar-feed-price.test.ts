import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify from "fastify";

/**
 * BAZAAR_FEED_PRICE_USDC: "0" deja GET /api/v1/bazaar/feed sin x402 (fase de
 * pruebas, para la consola web); cualquier otro valor sigue cobrando.
 * El precio se lee al registrar la ruta, así que cada caso recarga los módulos.
 */

vi.mock("../services/stellar.service.js", () => ({
  lockAtomicSwap: vi.fn(),
}));

vi.mock("../db/bazaar.js", () => ({
  initBazaarTables:    vi.fn(async () => {}),
  seedAgentHistories:  vi.fn(async () => {}),
  seedIntents:         vi.fn(async () => {}),
  createIntent:        vi.fn(async (i: unknown) => i),
  getIntent:           vi.fn(async () => null),
  getActiveIntents:    vi.fn(async () => []),
  updateIntent:        vi.fn(async () => {}),
  createQuote:         vi.fn(async (q: unknown) => q),
  getQuotesForIntent:  vi.fn(async () => []),
  getAgentHistory:     vi.fn(async () => null),
  upsertAgentHistory:  vi.fn(async () => {}),
  intentRowToObject:   (row: unknown) => row,
  getBazaarStats:      vi.fn(async () => ({})),
}));

async function feedWithPrice(price: string | undefined) {
  if (price === undefined) delete process.env.BAZAAR_FEED_PRICE_USDC;
  else process.env.BAZAAR_FEED_PRICE_USDC = price;
  vi.resetModules();
  const { bazaarRoutes } = await import("../routes/bazaar.js");
  const app = Fastify();
  await app.register(bazaarRoutes);
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/api/v1/bazaar/feed" });
  await app.close();
  return res;
}

describe("GET /api/v1/bazaar/feed — BAZAAR_FEED_PRICE_USDC", () => {
  afterEach(() => {
    delete process.env.BAZAAR_FEED_PRICE_USDC;
  });

  it("sin variable cobra 0.001 (402 sin x-payment)", async () => {
    const res = await feedWithPrice(undefined);
    expect(res.statusCode).toBe(402);
    expect(res.body).toContain("0.001");
  });

  it('con "0" sirve el feed sin x-payment', async () => {
    const res = await feedWithPrice("0");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).intents).toEqual([]);
  });

  it("con otro precio cobra ese precio", async () => {
    const res = await feedWithPrice("0.002");
    expect(res.statusCode).toBe(402);
    expect(res.body).toContain("0.002");
  });
});

describe("GET /api/v1/swaps/:id/status — SWAP_STATUS_PRICE_USDC", () => {
  async function statusWithPrice(price: string | undefined) {
    if (price === undefined) delete process.env.SWAP_STATUS_PRICE_USDC;
    else process.env.SWAP_STATUS_PRICE_USDC = price;
    vi.resetModules();
    const { swapRoutes } = await import("../routes/swaps.js");
    const app = Fastify();
    await app.register(swapRoutes);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/v1/swaps/no-existe/status" });
    await app.close();
    return res;
  }

  afterEach(() => {
    delete process.env.SWAP_STATUS_PRICE_USDC;
  });

  it("sin variable cobra 0.0001 (402 sin x-payment)", async () => {
    const res = await statusWithPrice(undefined);
    expect(res.statusCode).toBe(402);
    expect(res.body).toContain("0.0001");
  });

  it('con "0" llega al handler sin x-payment', async () => {
    const res = await statusWithPrice("0");
    expect(res.statusCode).toBe(404);
  });
});
