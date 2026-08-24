import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import fs from "fs";

/**
 * Puertas de autorizacion y validez en POST /api/v1/bazaar/accept (#8).
 *
 * `accept` solo comprobaba que el intent existiera y estuviera `active`. Todo
 * lo demas que deberia condicionar una liquidacion faltaba: podias aceptar tu
 * propio intent, uno vencido, con una quote vencida, con una quote de otro
 * intent, por debajo del `min_rate` que el autor habia declarado — y si el
 * intent no pedia USDC, el importe del escrow salia de un literal inventado.
 *
 * La propiedad que sostiene todo este archivo: **ninguna ruta de rechazo
 * bloquea fondos**. Un 4xx que ya haya llamado a `lockAtomicSwap` deja un
 * escrow en cadena sin nadie que lo libere, y el bazaar no tiene reembolso.
 * Por eso cada test de rechazo verifica ademas que el lock no se llamo.
 *
 * Corre offline: se mockean el servicio de Stellar y la capa de base.
 */

const INTENT_ID = "int-val";
const AUTOR = "GAUTOR";
const ACEPTADOR = "GTESTBAZAAR"; // el que firma el x-payment de abajo

// `vi.hoisted` se evalua antes que las factorias de `vi.mock`, asi que la
// factoria puede cerrar sobre este objeto sin caer en el "Cannot access before
// initialization" que da un `const` normal.
const estado = vi.hoisted(() => ({
  intent: null as any,
  quotes: [] as any[],
  porId: new Map<string, any>(),
}));

vi.mock("../services/stellar.service.js", () => ({
  lockAtomicSwap: vi.fn(async () => ({
    txHash: "tx-val",
    swapId: "swap-val",
    explorerUrl: "https://stellar.expert/explorer/testnet/tx/tx-val",
  })),
}));

vi.mock("../db/bazaar.js", () => ({
  initBazaarTables: vi.fn(async () => {}),
  seedAgentHistories: vi.fn(async () => {}),
  seedIntents: vi.fn(async () => {}),
  createIntent: vi.fn(async (i: unknown) => i),
  getIntent: vi.fn(async () => estado.intent),
  getActiveIntents: vi.fn(async () => []),
  updateIntent: vi.fn(async () => {}),
  createQuote: vi.fn(async (q: unknown) => q),
  getQuote: vi.fn(async (id: string) => estado.porId.get(id) ?? null),
  getQuotesForIntent: vi.fn(async () => estado.quotes),
  getAgentHistory: vi.fn(async () => null),
  upsertAgentHistory: vi.fn(async () => {}),
  intentRowToObject: (row: unknown) => row,
  getBazaarStats: vi.fn(async () => ({})),
}));

import { bazaarRoutes } from "../routes/bazaar.js";
import { lockAtomicSwap } from "../services/stellar.service.js";

const HASH = "a3f1".repeat(16); // 64 hex en minuscula, lo que exige el schema
const PAGO = { "x-payment": `mock:${ACEPTADOR}:0.005`, "content-type": "application/json" };

const dentroDe = (ms: number) => new Date(Date.now() + ms).toISOString();

function intent(over: Record<string, unknown> = {}) {
  return {
    id: INTENT_ID,
    agent_address: AUTOR,
    status: "active" as const,
    offered_chain: "xrpl", offered_symbol: "XRP", offered_amount: "50",
    wanted_chain: "stellar", wanted_symbol: "USDC", wanted_amount: "25",
    min_rate: null,
    secret_hash: null,
    selected_quote_id: null,
    created_at: new Date().toISOString(),
    expires_at: dentroDe(3600_000),
    ...over,
  };
}

function quote(over: Record<string, unknown> = {}) {
  return {
    id: "qut-1",
    intent_id: INTENT_ID,
    from_agent: "GMAKER",
    rate: 1,
    valid_until: dentroDe(300_000),
    created_at: new Date().toISOString(),
    ...over,
  };
}

/** Registra las quotes para que `getQuote` y `getQuotesForIntent` concuerden. */
function conQuotes(...qs: any[]) {
  estado.quotes = qs;
  estado.porId = new Map(qs.map((q) => [q.id, q]));
}

const aceptar = (app: FastifyInstance, payload: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: "/api/v1/bazaar/accept",
    headers: PAGO,
    payload: { intent_id: INTENT_ID, secret_hash: HASH, ...payload },
  });

describe("POST /api/v1/bazaar/accept — puertas de autorizacion y validez (#8)", () => {
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
    vi.mocked(lockAtomicSwap).mockClear();
    estado.intent = intent();
    conQuotes(quote());
  });

  // ── autorizacion ───────────────────────────────────────────────────────────

  it("403 si el aceptador es el propio autor del intent", async () => {
    // El pago lo firma ACEPTADOR, asi que se hace autor a ese mismo.
    estado.intent = intent({ agent_address: ACEPTADOR });

    const res = await aceptar(app, {});

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("self_acceptance_forbidden");
    expect(vi.mocked(lockAtomicSwap)).not.toHaveBeenCalled();
  });

  // ── vigencia del intent ────────────────────────────────────────────────────

  it("409 si el intent ya vencio", async () => {
    estado.intent = intent({ expires_at: dentroDe(-60_000) });

    const res = await aceptar(app, {});

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("intent_expired");
    expect(vi.mocked(lockAtomicSwap)).not.toHaveBeenCalled();
  });

  // ── quote indicada explicitamente ──────────────────────────────────────────

  it("404 si el quote_id no existe", async () => {
    const res = await aceptar(app, { quote_id: "qut-fantasma" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("quote_not_found");
    expect(vi.mocked(lockAtomicSwap)).not.toHaveBeenCalled();
  });

  it("409 si el quote_id pertenece a otro intent", async () => {
    // Existe, es valida, y esta vigente: lo unico malo es de quien es. Por eso
    // no basta con buscarla entre las del intent — ahi seria indistinguible de
    // una que no existe, y son dos respuestas distintas.
    const ajena = quote({ id: "qut-ajena", intent_id: "int-otro" });
    conQuotes(quote(), ajena);

    const res = await aceptar(app, { quote_id: "qut-ajena" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("quote_intent_mismatch");
    expect(vi.mocked(lockAtomicSwap)).not.toHaveBeenCalled();
  });

  it("409 si la quote indicada ya vencio", async () => {
    conQuotes(quote({ id: "qut-vieja", valid_until: dentroDe(-1_000) }));

    const res = await aceptar(app, { quote_id: "qut-vieja" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("quote_expired");
    expect(vi.mocked(lockAtomicSwap)).not.toHaveBeenCalled();
  });

  // ── seleccion automatica ───────────────────────────────────────────────────

  it("409 si no queda ninguna quote vigente y no se indico quote_id", async () => {
    conQuotes(quote({ valid_until: dentroDe(-1_000) }));

    const res = await aceptar(app, {});

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_valid_quote");
    expect(vi.mocked(lockAtomicSwap)).not.toHaveBeenCalled();
  });

  it("sin quote_id elige la de mejor rate, no la primera que llego", async () => {
    // El orden es deliberado: la peor va primera, que es la que devolvia el
    // `quotes[0]` de antes. Si la seleccion se rompe, este test lo dice.
    conQuotes(
      quote({ id: "qut-peor",  rate: 0.90, from_agent: "GPEOR" }),
      quote({ id: "qut-mejor", rate: 1.15, from_agent: "GMEJOR" }),
      quote({ id: "qut-media", rate: 1.05, from_agent: "GMEDIA" }),
    );

    const res = await aceptar(app, {});

    expect(res.statusCode).toBe(200);
    expect(res.json().handshake.quote_id).toBe("qut-mejor");
    expect(res.json().handshake.market_maker).toBe("GMEJOR");
  });

  it("una quote vencida no gana aunque tenga el mejor rate", async () => {
    conQuotes(
      quote({ id: "qut-vigente", rate: 1.0 }),
      quote({ id: "qut-vencida", rate: 9.9, valid_until: dentroDe(-1_000) }),
    );

    const res = await aceptar(app, {});

    expect(res.statusCode).toBe(200);
    expect(res.json().handshake.quote_id).toBe("qut-vigente");
  });

  it("compara el rate como numero, no como texto", async () => {
    // pg devuelve DECIMAL como string. Con `<` entre strings, "0.9" > "0.15"
    // es falso y "9" > "10" es cierto: la comparacion lexicografica elige mal.
    conQuotes(
      quote({ id: "qut-str-alta", rate: "9" as unknown as number }),
      quote({ id: "qut-str-baja", rate: "10" as unknown as number }),
    );

    const res = await aceptar(app, {});

    expect(res.statusCode).toBe(200);
    expect(res.json().handshake.quote_id).toBe("qut-str-baja"); // 10 > 9
  });

  // ── min_rate ───────────────────────────────────────────────────────────────

  it("409 si la quote seleccionada queda por debajo del min_rate del intent", async () => {
    estado.intent = intent({ min_rate: 1.2 });
    conQuotes(quote({ rate: 1.1 }));

    const res = await aceptar(app, {});

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("quote_below_min_rate");
    expect(vi.mocked(lockAtomicSwap)).not.toHaveBeenCalled();
  });

  it("min_rate exactamente igual al rate se acepta", async () => {
    estado.intent = intent({ min_rate: 1.2 });
    conQuotes(quote({ rate: 1.2 }));

    const res = await aceptar(app, {});

    expect(res.statusCode).toBe(200);
  });

  it("min_rate en string (DECIMAL de pg) se compara como numero", async () => {
    estado.intent = intent({ min_rate: "1.2" as unknown as number });
    conQuotes(quote({ rate: "1.1" as unknown as number }));

    const res = await aceptar(app, {});

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("quote_below_min_rate");
    expect(vi.mocked(lockAtomicSwap)).not.toHaveBeenCalled();
  });

  // ── importe del escrow ─────────────────────────────────────────────────────

  it("deriva el importe del lado del intent que esta en USDC", async () => {
    estado.intent = intent({ wanted_symbol: "USDC", wanted_amount: "25" });

    const res = await aceptar(app, {});

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(lockAtomicSwap)).toHaveBeenCalledWith(
      expect.objectContaining({ amountUsdc: 25 }),
    );
  });

  it("tambien lo deriva si el USDC esta en el lado ofrecido", async () => {
    estado.intent = intent({
      offered_symbol: "USDC", offered_amount: "40",
      wanted_symbol: "XRP", wanted_amount: "80",
    });

    const res = await aceptar(app, {});

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(lockAtomicSwap)).toHaveBeenCalledWith(
      expect.objectContaining({ amountUsdc: 40 }),
    );
  });

  it("400 si ninguna pata es USDC, en vez de inventarse un importe", async () => {
    // Este es el caso que antes caia en el literal "28.57" y acababa en un
    // escrow real.
    estado.intent = intent({
      offered_symbol: "XRP", offered_amount: "50",
      wanted_symbol: "MXN", wanted_amount: "8750",
    });

    const res = await aceptar(app, {});

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("amount_not_derivable");
    expect(vi.mocked(lockAtomicSwap)).not.toHaveBeenCalled();
  });

  it("un amount_usdc explicito sigue mandando sobre el derivado", async () => {
    estado.intent = intent({ wanted_symbol: "USDC", wanted_amount: "25" });

    const res = await aceptar(app, { amount_usdc: 7 });

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(lockAtomicSwap)).toHaveBeenCalledWith(
      expect.objectContaining({ amountUsdc: 7 }),
    );
  });

  it("no queda ningun importe cableado en la ruta", async () => {
    // El criterio del issue es literal: "No hardcoded amount remains in the
    // file". Se comprueba sobre la fuente para que nadie lo reintroduzca.
    //
    // Se miran los comentarios aparte: el comentario que explica el arreglo
    // nombra el 28.57 a proposito, y eso es documentacion, no un importe. Lo
    // que no puede volver es el numero como valor.
    const fuente = fs.readFileSync(new URL("../routes/bazaar.ts", import.meta.url), "utf8");
    const codigo = fuente
      .replace(/\/\*[\s\S]*?\*\//g, "")   // bloques /* ... */
      .replace(/\/\/.*$/gm, "");          // linea // ...

    expect(codigo).not.toContain("28.57");
  });

  // ── camino feliz ───────────────────────────────────────────────────────────

  it("con todo en regla bloquea y responde 200", async () => {
    const res = await aceptar(app, {});

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("negotiating");
    expect(res.json().handshake.secret_hash).toBe(HASH);
    expect(vi.mocked(lockAtomicSwap)).toHaveBeenCalledOnce();
  });
});
