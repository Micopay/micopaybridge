import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

/**
 * #33 (BRIDGE-16): nada de actividad inventada en `agent_history`, y las
 * rutas que la leen describen la ausencia en vez de disfrazarla de cero.
 *
 * El historial en memoria de la ruta es el unico almacen disponible en estos
 * tests (sin base de datos): se cargan casos reales — emision de broadcast —
 * a traves del propio endpoint de intents, y los caminos vacios se prueban
 * tal como quedan: vacios.
 */

const PAYER = "GPIXELPAGANQUIERE saber si confiar";
const PAYER_ADDR = "GDPAYER00000000000000000000000000000000000000000000000";

vi.mock("../services/stellar.service.js", () => ({
  lockAtomicSwap: vi.fn(async () => ({
    txHash: "tx-test",
    swapId: "swap-test",
    explorerUrl: "https://stellar.expert/explorer/testnet/tx/tx-test",
  })),
}));

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../db/schema.js", () => ({
  query: queryMock,
  getOne: vi.fn(async () => null),
  getMany: vi.fn(async () => []),
}));

// La base de datos de bazaar: el mismo modulo de rutas se comunica con
// getAgentHistory/upsertAgentHistory, que aqui estan cableados a un Map
// local para no requerir PostgreSQL en el test.
const hist = new Map<string, any>();
vi.mock("../db/bazaar.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../db/bazaar.js")>();
  return {
    ...orig,
    initBazaarTables: vi.fn(async () => {}),
    seedIntents: vi.fn(async () => {}),
    getIntent: vi.fn(async () => null),
    getActiveIntents: vi.fn(async () => []),
    getAgentHistory: vi.fn(async (a: string) => hist.get(a) ?? null),
    upsertAgentHistory: vi.fn(async (a: string, delta: Record<string, number>) => {
      const cur = hist.get(a) ?? {
        agent_address: a, broadcasts: 0, swaps_completed: 0, swaps_cancelled: 0,
        volume_usdc: 0, first_seen: new Date().toISOString(), last_active: new Date().toISOString(),
      };
      const upd = {
        ...cur,
        broadcasts: cur.broadcasts + (delta.broadcasts ?? 0),
        swaps_completed: cur.swaps_completed + (delta.swaps_completed ?? 0),
        swaps_cancelled: cur.swaps_cancelled + (delta.swaps_cancelled ?? 0),
        volume_usdc: cur.volume_usdc + (delta.volume_usdc ?? 0),
        last_active: new Date().toISOString(),
      };
      hist.set(a, upd);
      return upd;
    }),
    getBazaarStats: vi.fn(async () => {
      const rows = [...hist.values()];
      const totalSwapsCompleted = rows.reduce((s, r) => s + r.swaps_completed, 0);
      return {
        total_intents: 0, active_intents: 0, negotiating_intents: 0, executed_intents: 0, expired_intents: 0,
        total_volume_usdc: rows.reduce((s, r) => s + r.volume_usdc, 0),
        total_broadcasts: rows.reduce((s, r) => s + r.broadcasts, 0),
        total_swaps_completed: totalSwapsCompleted,
        total_swaps_cancelled: rows.reduce((s, r) => s + r.swaps_cancelled, 0),
        top_agents: rows.map((r) => ({
          agent_address: r.agent_address, broadcasts: r.broadcasts,
          swaps_completed: r.swaps_completed, completion_rate: 0, volume_usdc: r.volume_usdc,
          tier: "espora", tier_emoji: "🌱",
        })),
        recent_intents: [],
        reputation_status: totalSwapsCompleted > 0 ? "live" : "no_settlement_data",
        reputation_note: totalSwapsCompleted > 0 ? "live" : "none yet",
      };
    }),
  };
});

import { bazaarRoutes } from "../routes/bazaar.js";

const PAGO = {
  "x-payment": `mock:${PAYER_ADDR}:0.005`,
  "content-type": "application/json",
};

describe("BRIDGE-16 (#33): no invented agent history", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.X402_MOCK_MODE = "true";
    app = Fastify();
    await app.register(bazaarRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.X402_MOCK_MODE;
  });

  beforeEach(() => {
    hist.clear();
    queryMock.mockReset();
  });

  it("a fresh deployment serves no agent with non-zero swaps_completed", async () => {
    // Un broadcast real crea la fila; sin settlement no hay swaps que contar.
    await app.inject({
      method: "POST",
      url: "/api/v1/bazaar/intent",
      headers: PAGO,
      payload: {
        offered: { chain: "stellar", symbol: "USDC", amount: "10" },
        wanted: { chain: "ethereum", symbol: "ETH", amount: "0.003" },
      },
    });

    const rep = await app.inject({
      method: "GET",
      url: `/api/v1/bazaar/reputation/${PAYER_ADDR}`,
    });
    expect(rep.statusCode).toBe(200);
    const body = JSON.parse(rep.body);
    expect(body.history_available).toBe(true);
    expect(body.agent_reputation.swaps_completed).toBe(0);
    expect(body.agent_reputation.tier).toBe("espora");
  });

  it("reputation for an unknown address says WHY there is no history — no computed zero", async () => {
    const rep = await app.inject({
      method: "GET",
      url: "/api/v1/bazaar/reputation/GNADIE00000000000000000000000000000000000000000000000",
    });
    expect(rep.statusCode).toBe(200);
    const body = JSON.parse(rep.body);
    expect(body.history_available).toBe(false);
    expect(body.reason).toBe("no_recorded_history");
    expect(body.agent_reputation).toBeNull();
    expect(body.data_source).toContain("no row");
    expect(body.agent_signal.trusted).toBe(false);
  });

  it("stats does not present any agent as a settlement-proven top_agent", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/bazaar/intent",
      headers: PAGO,
      payload: {
        offered: { chain: "stellar", symbol: "USDC", amount: "10" },
        wanted: { chain: "ethereum", symbol: "ETH", amount: "0.003" },
      },
    });

    const stats = await app.inject({ method: "GET", url: "/api/v1/bazaar/stats" });
    expect(stats.statusCode).toBe(200);
    const body = JSON.parse(stats.body);
    expect(body.total_swaps_completed).toBe(0);
    expect(body.reputation_status).toBe("no_settlement_data");
    for (const agent of body.top_agents) {
      expect(agent.swaps_completed).toBe(0);
    }
  });

  it("the DB-unavailable path serves no invented figures either", async () => {
    // getBazaarStats lanza → la ruta responde degradada: ceros estructurales
    // + bandera, nunca los numeros del viejo seed.
    const { getBazaarStats } = await import("../db/bazaar.js");
    const boom = vi.mocked(getBazaarStats).mockRejectedValueOnce(new Error("db down") as never);

    const stats = await app.inject({ method: "GET", url: "/api/v1/bazaar/stats" });
    expect(stats.statusCode).toBe(200);
    const body = JSON.parse(stats.body);
    expect(body.data_source).toBe("unavailable (degraded)");
    expect(body.top_agents).toEqual([]);
    expect(body.total_swaps_completed).toBe(0);
    expect(body.reputation_note).toContain("no substitute figures");
    expect(boom).toBeTruthy();
  });

  it("reputation on the DB-unavailable path distinguishes db_unavailable from no_recorded_history", async () => {
    const { getAgentHistory } = await import("../db/bazaar.js");
    const boom = vi.mocked(getAgentHistory).mockRejectedValueOnce(new Error("db down") as never);

    const rep = await app.inject({
      method: "GET",
      url: `/api/v1/bazaar/reputation/${PAYER_ADDR}`,
    });
    expect(rep.statusCode).toBe(200);
    const body = JSON.parse(rep.body);
    expect(body.history_available).toBe(false);
    expect(body.reason).toBe("db_unavailable");
    expect(body.agent_reputation).toBeNull();
    expect(boom).toBeTruthy();
  });
});
