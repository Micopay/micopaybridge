import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

// #33 (BRIDGE-16): estos tests asumian la base de datos real con su semilla
// de dos agentes. Sin PostgreSQL (CI) fallaban por razon equivocada, y con
// PostgreSQL publicaban los numeros inventados. Ahora el almacen es un Map
// local, como en el resto de la suite de bazaar: se cargan filas REALES —
// broadcasts emitidos — y la ausencia se prueba vacia.
const hist = vi.hoisted(() => new Map<string, any>());

vi.mock("../db/bazaar.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../db/bazaar.js")>();
  return {
    ...orig,
    initBazaarTables: vi.fn(async () => {}),
    seedIntents: vi.fn(async () => {}),
    getActiveIntents: vi.fn(async () => []),
    getAgentHistory: vi.fn(async (a: string) => hist.get(a) ?? null),
    getBazaarStats: vi.fn(async () => {
      const rows = [...hist.values()];
      const totalSwaps = rows.reduce((s, r) => s + r.swaps_completed, 0);
      return {
        total_intents: 0, active_intents: 0, negotiating_intents: 0,
        executed_intents: 0, expired_intents: 0,
        total_volume_usdc: rows.reduce((s, r) => s + r.volume_usdc, 0),
        total_broadcasts: rows.reduce((s, r) => s + r.broadcasts, 0),
        total_swaps_completed: totalSwaps,
        total_swaps_cancelled: rows.reduce((s, r) => s + r.swaps_cancelled, 0),
        top_agents: rows.map((r) => ({
          agent_address: r.agent_address, broadcasts: r.broadcasts,
          swaps_completed: r.swaps_completed, completion_rate: 0,
          volume_usdc: r.volume_usdc, tier: "espora", tier_emoji: "🌱",
        })),
        recent_intents: [],
        reputation_status: totalSwaps > 0 ? "live" : "no_settlement_data",
        reputation_note: totalSwaps > 0 ? "live" : "none yet",
      };
    }),
  };
});

import { bazaarRoutes } from "../routes/bazaar.js";

describe("Bazaar Routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(bazaarRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /api/v1/bazaar/feed", () => {
    it("should return 402 without payment", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/feed",
      });

      expect(response.statusCode).toBe(402);
      const body = JSON.parse(response.body);
      expect(body.status).toBe(402);
      expect(body.error).toBe("Payment Required");
      expect(body.challenge.scheme).toBe("stellar-usdc");
    });
  });

  describe("GET /api/v1/bazaar/stats", () => {
    it("should return bazaar statistics", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/stats",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.total_intents).toBeDefined();
      expect(body.active_intents).toBeDefined();
      expect(body.total_volume_usdc).toBeDefined();
      expect(body.top_agents).toBeInstanceOf(Array);
      expect(body.recent_intents).toBeInstanceOf(Array);
      expect(body.network).toBe("global-intent-layer");
      expect(body.queried_at).toBeDefined();
    });

    it("should include agent stats in top_agents for agents with real broadcasts", async () => {
      // Fila creada por actividad real: broadcasts emitidos, cero swaps
      // (el bazaar aun no tiene settlement). Sin semilla, esta es la unica
      // forma legitima de aparecer aqui.
      hist.set("GBROADCASTER00000000000000000000000000000000000000000000", {
        agent_address: "GBROADCASTER00000000000000000000000000000000000000000000000",
        broadcasts: 3, swaps_completed: 0, swaps_cancelled: 0, volume_usdc: 0,
        first_seen: "2026-08-01T00:00:00.000Z", last_active: "2026-08-20T00:00:00.000Z",
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/stats",
      });

      const body = JSON.parse(response.body);
      expect(body.top_agents.length).toBe(1);
      const agent = body.top_agents[0];
      expect(agent.agent_address).toBeDefined();
      expect(agent.broadcasts).toBe(3);
      expect(agent.swaps_completed).toBe(0);
      expect(body.reputation_status).toBe("no_settlement_data");
    });
  });

  describe("POST /api/v1/bazaar/intent", () => {
    it("should return 402 without payment", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/bazaar/intent",
        payload: {
          offered: { chain: "ethereum", symbol: "ETH", amount: "1.0" },
          wanted: { chain: "stellar", symbol: "USDC", amount: "2800" },
        },
      });

      expect(response.statusCode).toBe(402);
    });
  });

  describe("GET /api/v1/bazaar/reputation/:address", () => {
    // #33 (BRIDGE-16): la direccion que antes venia pre-sembrada como
    // "maestro" ya no tiene fila; sin semilla no hay historial que servir.
    it("reports no recorded history for an address the seed used to pre-populate", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/reputation/GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.history_available).toBe(false);
      expect(body.reason).toBe("no_recorded_history");
      expect(body.agent_reputation).toBeNull();
      expect(body.agent_signal.trusted).toBe(false);
    });

    it("reports no recorded history for an unknown address instead of a computed zero", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bazaar/reputation/GUNKNOWNTESTADDRESS123456789012345678901234567890",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.history_available).toBe(false);
      expect(body.reason).toBe("no_recorded_history");
      expect(body.agent_reputation).toBeNull();
      expect(body.agent_signal.trusted).toBe(false);
    });
  });
});
