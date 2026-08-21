import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

/**
 * BRIDGE-09: /swaps/search cobra $0.001 por encontrar contrapartes y devolvia
 * una sola, siempre la misma direccion demo, con completion_rate: 0.98 escrito
 * a mano. El campo inventado era justo el de confiabilidad, y available_amount
 * —tambien inventado— es el que decide si esa contraparte se ofrece.
 *
 * Offline: Horizon mockeado con fetch, agent_history mockeado.
 */

const DEMO_ADDRESS = "GDEMOAGENTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

const getAgentHistory = vi.fn(async (_addr: string) => null as unknown);

vi.mock("../db/bazaar.js", () => ({
  getAgentHistory: (addr: string) => getAgentHistory(addr),
  initBazaarTables: vi.fn(async () => {}),
  seedAgentHistories: vi.fn(async () => {}),
  seedIntents: vi.fn(async () => {}),
  upsertAgentHistory: vi.fn(async () => {}),
}));

const PAGO = { "x-payment": "mock:GTESTSEARCH:0.001" };

describe("GET /api/v1/swaps/search: ninguna cifra de reputacion inventada", () => {
  let app: FastifyInstance;
  const fetchOriginal = globalThis.fetch;

  beforeAll(async () => {
    process.env.X402_MOCK_MODE = "true";
    const { swapRoutes } = await import("../routes/swaps.js");
    app = Fastify();
    await app.register(swapRoutes);
    await app.ready();
  });

  // El backoff vive en el modulo: sin resetear, un test contamina al siguiente.
  async function appNueva(env: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    vi.resetModules();
    const { swapRoutes } = await import("../routes/swaps.js");
    const nueva = Fastify();
    await nueva.register(swapRoutes);
    await nueva.ready();
    return nueva;
  }

  afterAll(async () => {
    await app.close();
    globalThis.fetch = fetchOriginal;
    delete process.env.X402_MOCK_MODE;
  });

  beforeEach(() => {
    getAgentHistory.mockReset().mockResolvedValue(null);
    // Order book de Horizon: un ask real, para que `rate` siga siendo medido.
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ asks: [{ price: "6.0000" }], bids: [] }),
    })) as unknown as typeof fetch;
  });

  async function search(qs = "?sell_asset=USDC&buy_asset=XLM") {
    const res = await app.inject({ method: "GET", url: `/api/v1/swaps/search${qs}`, headers: PAGO });
    return { res, body: JSON.parse(res.body) };
  }

  it("sin historial en agent_history, completion_rate es null, no un numero", async () => {
    const { res, body } = await search();

    expect(res.statusCode).toBe(200);
    const cp = body.counterparties[0];
    expect(cp.completion_rate).toBeNull();
    expect(cp.swaps_completed).toBeNull();
    expect(cp.avg_time_seconds).toBeNull();
    // El literal viejo
    expect(JSON.stringify(body)).not.toContain("0.98");
  });

  it("con historial, completion_rate se deriva de agent_history", async () => {
    getAgentHistory.mockResolvedValue({
      agent_address: DEMO_ADDRESS,
      broadcasts: 10,
      swaps_completed: 7,
      swaps_cancelled: 3,
      volume_usdc: 900,
      first_seen: "2026-01-01T00:00:00Z",
      last_active: "2026-08-19T00:00:00Z",
    });

    const { body } = await search();

    expect(body.counterparties[0].completion_rate).toBe(0.7);
    expect(body.counterparties[0].swaps_completed).toBe(7);
  });

  it("si la base falla, sigue siendo null: no hay numero de relleno", async () => {
    getAgentHistory.mockRejectedValue(new Error("ECONNREFUSED"));

    const { res, body } = await search();

    expect(res.statusCode).toBe(200);
    expect(body.counterparties[0].completion_rate).toBeNull();
  });

  it("la entrada sembrada va marcada como demo y su inventario como estimacion", async () => {
    const { body } = await search();

    expect(body.counterparties[0].source).toBe("demo");
    expect(body.counterparties[0].available_amount_source).toBe("estimate");
    expect(body.reputation_source).toBe("agent_history");
  });

  it("con la base caida no se reintenta en cada busqueda pagada", async () => {
    getAgentHistory.mockRejectedValue(new Error("ECONNREFUSED"));
    const nueva = await appNueva({ REPUTATION_DB_RETRY_MS: "30000" });
    getAgentHistory.mockClear();

    for (let i = 0; i < 20; i++) {
      const r = await nueva.inject({ method: "GET", url: "/api/v1/swaps/search", headers: PAGO });
      expect(r.statusCode).toBe(200);
    }

    // Antes: 20 busquedas = 20 intentos de conexion, cada uno hasta 5 s por el
    // connectionTimeoutMillis de schema.ts.
    expect(getAgentHistory).toHaveBeenCalledTimes(1);
    await nueva.close();
    delete process.env.REPUTATION_DB_RETRY_MS;
  });

  it("una base lenta no cuelga la busqueda: hay tope de espera", async () => {
    // Nunca resuelve: es el caso que peor duele, la base que no contesta ni
    // rechaza.
    getAgentHistory.mockImplementation(() => new Promise(() => {}) as never);
    const nueva = await appNueva({ REPUTATION_LOOKUP_TIMEOUT_MS: "150" });

    const t0 = Date.now();
    const r = await nueva.inject({ method: "GET", url: "/api/v1/swaps/search", headers: PAGO });
    const tardo = Date.now() - t0;

    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).counterparties[0].completion_rate).toBeNull();
    // El umbral se mide contra lo que se quiere evitar —los 5 s de
    // connectionTimeoutMillis de schema.ts— no contra el tope configurado:
    // un margen apretado convierte este test en uno que falla por carga de CI,
    // no por el bug.
    expect(tardo).toBeLessThan(4_000);
    await nueva.close();
    delete process.env.REPUTATION_LOOKUP_TIMEOUT_MS;
  });

  it("una direccion sin historial NO abre la ventana de backoff", async () => {
    const nueva = await appNueva();
    getAgentHistory.mockResolvedValue(null);

    await nueva.inject({ method: "GET", url: "/api/v1/swaps/search", headers: PAGO });
    getAgentHistory.mockClear();
    await nueva.inject({ method: "GET", url: "/api/v1/swaps/search", headers: PAGO });

    // "sin fila" es una respuesta legitima, no un fallo de base: la siguiente
    // busqueda vuelve a consultar.
    expect(getAgentHistory).toHaveBeenCalledTimes(1);
    await nueva.close();
  });

  it("un intervalo de reintento invalido no desactiva el backoff", async () => {
    // `Math.max(Number("medio minuto"), 1000)` daba NaN, y `ahora - ultimo <
    // NaN` es siempre false: 20 busquedas = 20 conexiones con la base caida.
    getAgentHistory.mockRejectedValue(new Error("ECONNREFUSED"));
    const nueva = await appNueva({ REPUTATION_DB_RETRY_MS: "medio minuto" });
    getAgentHistory.mockClear();

    for (let i = 0; i < 20; i++) {
      await nueva.inject({ method: "GET", url: "/api/v1/swaps/search", headers: PAGO });
    }

    expect(getAgentHistory).toHaveBeenCalledTimes(1);
    await nueva.close();
    delete process.env.REPUTATION_DB_RETRY_MS;
  });

  it("un tope de espera invalido no apaga la reputacion", async () => {
    // setTimeout(fn, NaN) dispara al instante: contra una base sana, la
    // reputacion salia null y ademas se abria la ventana de backoff.
    getAgentHistory.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return {
        agent_address: "G", broadcasts: 10, swaps_completed: 7, swaps_cancelled: 3,
        volume_usdc: 900, first_seen: "2026-01-01T00:00:00Z", last_active: "2026-08-19T00:00:00Z",
      } as never;
    });
    const nueva = await appNueva({ REPUTATION_LOOKUP_TIMEOUT_MS: "un segundo" });

    const r = await nueva.inject({ method: "GET", url: "/api/v1/swaps/search", headers: PAGO });

    expect(JSON.parse(r.body).counterparties[0].completion_rate).toBe(0.7);
    await nueva.close();
    delete process.env.REPUTATION_LOOKUP_TIMEOUT_MS;
  });

  it("msDesdeEntorno: basura al default, valor bajo el piso al piso", async () => {
    const { msDesdeEntorno } = await import("../routes/swaps.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(msDesdeEntorno("medio minuto", 30_000, 1_000, "X")).toBe(30_000);
    expect(msDesdeEntorno("1e309", 30_000, 1_000, "X")).toBe(30_000);
    expect(msDesdeEntorno("-5", 30_000, 1_000, "X")).toBe(30_000);
    expect(msDesdeEntorno("", 30_000, 1_000, "X")).toBe(30_000);
    expect(msDesdeEntorno(undefined, 30_000, 1_000, "X")).toBe(30_000);
    expect(msDesdeEntorno("0", 30_000, 1_000, "X")).toBe(1_000);
    expect(msDesdeEntorno("5000", 30_000, 1_000, "X")).toBe(5_000);
    warn.mockRestore();
  });

  it("el rate sigue viniendo de Horizon y no lo toca este cambio", async () => {
    const { body } = await search();

    // ask 6.0000 con 0.1% de spread
    expect(body.counterparties[0].rate).toBe("5.9940");
    expect(body.market_rate).toBe("6.0000");
    expect(body.rate_source).toBe("horizon-testnet");
  });
});
