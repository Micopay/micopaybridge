import type { FastifyInstance } from "fastify";
import { requirePayment } from "../middleware/x402.js";
import type { CounterpartyInfo } from "@micopay/types";
import { swapStore, pendingRefunds, TX_CHAIN, type SwapState } from "../lib/swapStore.js";
import { refundSwap } from "../lib/soroban.js";
import { getAgentHistory } from "../db/bazaar.js";

const CONTRACT_A = process.env.ATOMIC_SWAP_CONTRACT_A ?? "CCDOUXIXSFXT2HTJAJGFNUJN6CKCYX2M6AL2BHHPEF6ISNHP2BGLS4KX";

// Un explorador por cadena. Antes todas las txs se enlazaban a stellar.expert;
// desde M4.5 la pierna B vive en XRPL y ese enlace daría 404 — peor, haría
// parecer inexistente una transacción que sí ocurrió.
const EXPLORERS = {
  stellar: "https://stellar.expert/explorer/testnet/tx",
  xrpl: "https://testnet.xrpl.org/transactions",
} as const;

function txLink(key: keyof SwapState["txs"], hash: string): string {
  return `${EXPLORERS[TX_CHAIN[key]]}/${hash}`;
}

const HORIZON_URL = "https://horizon-testnet.stellar.org";

// Known issuers on Stellar testnet
const ASSET_ISSUERS: Record<string, string> = {
  USDC: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  MXNe: "GBZXN7PIRZGNMHGA7MUUUF4GWMTISGNQ5E72TFL6GDWPE6K4RCAVOALV",
};

// Fallback rates if Horizon is unreachable
const FALLBACK_RATES: Record<string, Record<string, number>> = {
  USDC: { XLM: 6.12, MXNe: 19.72, USDC: 1.0 },
  XLM:  { USDC: 0.163, MXNe: 3.21,  XLM: 1.0 },
  MXNe: { USDC: 0.051, XLM: 0.311, MXNe: 1.0 },
};

// Simple in-memory cache — rate + timestamp
const rateCache = new Map<string, { rate: number; ts: number }>();
const CACHE_TTL_MS = 30_000; // 30 seconds

function assetParams(code: string): Record<string, string> {
  if (code === "XLM") return { asset_type: "native" };
  return {
    asset_type: code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
    asset_code: code,
    asset_issuer: ASSET_ISSUERS[code] ?? "",
  };
}

async function fetchRateFromHorizon(sell: string, buy: string): Promise<number> {
  const cacheKey = `${sell}/${buy}`;
  const cached = rateCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.rate;

  try {
    // Query order book: selling sell_asset, buying buy_asset
    const sellP = assetParams(sell);
    const buyP  = assetParams(buy);

    const params = new URLSearchParams({
      [`selling_${Object.keys(sellP)[0]}`]: Object.values(sellP)[0],
      ...(sellP.asset_code ? { selling_asset_code: sellP.asset_code, selling_asset_issuer: sellP.asset_issuer } : {}),
      [`buying_${Object.keys(buyP)[0]}`]: Object.values(buyP)[0],
      ...(buyP.asset_code ? { buying_asset_code: buyP.asset_code, buying_asset_issuer: buyP.asset_issuer } : {}),
      limit: "1",
    });

    // Build clean params
    const qs = new URLSearchParams();
    if (sell === "XLM") {
      qs.set("selling_asset_type", "native");
    } else {
      qs.set("selling_asset_type", sell.length <= 4 ? "credit_alphanum4" : "credit_alphanum12");
      qs.set("selling_asset_code", sell);
      qs.set("selling_asset_issuer", ASSET_ISSUERS[sell] ?? "");
    }
    if (buy === "XLM") {
      qs.set("buying_asset_type", "native");
    } else {
      qs.set("buying_asset_type", buy.length <= 4 ? "credit_alphanum4" : "credit_alphanum12");
      qs.set("buying_asset_code", buy);
      qs.set("buying_asset_issuer", ASSET_ISSUERS[buy] ?? "");
    }
    qs.set("limit", "3");

    const res = await fetch(`${HORIZON_URL}/order_book?${qs}`, {
      signal: AbortSignal.timeout(4000),
    });
    const data = await res.json() as { bids?: { price: string }[]; asks?: { price: string }[] };

    // Best ask = lowest price someone will sell buy_asset for sell_asset
    // For USDC→XLM: price is XLM/USDC (how many XLM per USDC)
    const ask = data.asks?.[0]?.price;
    const bid = data.bids?.[0]?.price;

    let rate: number;
    if (ask && parseFloat(ask) > 0 && parseFloat(ask) < 1000) {
      rate = parseFloat(ask);
    } else if (bid && parseFloat(bid) > 0) {
      rate = parseFloat(bid);
    } else {
      rate = FALLBACK_RATES[sell]?.[buy] ?? 1.0;
    }

    rateCache.set(cacheKey, { rate, ts: Date.now() });
    return rate;
  } catch {
    return FALLBACK_RATES[sell]?.[buy] ?? 1.0;
  }
}

// La misma dirección demo que routes/agent.ts exige en validatePlan
// (DEMO_AGENT_PUBLIC_KEY) — antes esto devolvía direcciones inventadas
// ("GDEMOSWAP1XXX...") que nunca podían coincidir, así que /swaps/execute
// rechazaba cualquier plan real con "Invalid counterparty_address".
const DEMO_AGENT_ADDRESS = process.env.DEMO_AGENT_PUBLIC_KEY ?? "GDEMOAGENTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

// BRIDGE-09: available_amount decide si la contraparte se ofrece o no. Como
// no hay forma de medir el inventario de un agente todavia, el techo es
// configuracion declarada como estimacion, no un literal escondido que parece
// medido.
const DEMO_AVAILABLE_AMOUNT = process.env.DEMO_COUNTERPARTY_AVAILABLE_USDC ?? "10000";

/**
 * Lectura de reputacion acotada en tiempo y con backoff.
 *
 * /swaps/search es un endpoint de pago que antes no tocaba la base. Leer
 * agent_history lo ata a Postgres, y sin freno eso significa dos cosas malas
 * medidas en el codigo: `schema.ts` conecta con `connectionTimeoutMillis` de
 * 5 s por defecto, asi que una base que no contesta anade 5 s a CADA busqueda
 * pagada; y con la base caida, cada peticion vuelve a intentar conectar.
 *
 * Mismo patron que ensureX402Initialized() y ensureBazaarInitialized(): tras
 * un fallo no se reintenta hasta pasado el intervalo, y mientras tanto se
 * responde sin reputacion — que es exactamente lo mismo que se responde para
 * una direccion sin historial. La busqueda no depende de la base para existir.
 */
const REPUTACION_TIMEOUT_MS = Math.max(Number(process.env.REPUTATION_LOOKUP_TIMEOUT_MS ?? 1_000), 100);
const REPUTACION_DB_RETRY_MS = Math.max(Number(process.env.REPUTATION_DB_RETRY_MS ?? 30_000), 1_000);
let ultimoFalloReputacion = 0;

type HistorialMinimo = { swaps_completed: number; broadcasts: number };

async function leerHistorialAcotado(address: string): Promise<HistorialMinimo | null> {
  const ahora = Date.now();
  if (ultimoFalloReputacion !== 0 && ahora - ultimoFalloReputacion < REPUTACION_DB_RETRY_MS) {
    return null; // ventana de backoff: ni se intenta
  }

  // La promesa perdedora sigue viva, pero nadie la espera: lo que se acota es
  // lo que el que paga espera, no lo que hace el pool por dentro.
  //
  // El centinela importa: "no hay fila para esa direccion" es una respuesta
  // legitima y rapida, no un fallo de base. Si las dos devolvieran null, un
  // agente sin historial abriria la ventana de backoff y dejaria sin
  // reputacion a los demas durante 30 s.
  const TIMEOUT = Symbol("timeout");
  const conTope = new Promise<typeof TIMEOUT>((resolve) => {
    const t = setTimeout(() => resolve(TIMEOUT), REPUTACION_TIMEOUT_MS);
    // No mantener vivo el proceso por un timer de lectura.
    if (typeof t === "object" && "unref" in t) t.unref();
  });

  try {
    const historial = await Promise.race([getAgentHistory(address), conTope]);
    if (historial === TIMEOUT) {
      ultimoFalloReputacion = Date.now();
      console.warn(
        `[swaps] reputacion no contesto en ${REPUTACION_TIMEOUT_MS}ms (siguiente intento en ${REPUTACION_DB_RETRY_MS / 1000}s)`,
      );
      return null;
    }
    ultimoFalloReputacion = 0;
    return historial;
  } catch (err) {
    ultimoFalloReputacion = Date.now();
    console.warn(
      `[swaps] lectura de reputacion fallida (siguiente intento en ${REPUTACION_DB_RETRY_MS / 1000}s):`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * completion_rate y swaps_completed salen de agent_history, que es la fuente
 * real de la reputacion de este mercado. Si esa direccion no tiene historial,
 * la respuesta dice null: inventar 0.98 es peor que no responder, porque el
 * campo inventado es justo el de confiabilidad y el agente paga por leerlo.
 */
async function buildCounterparties(sell: string, buy: string, amount?: string): Promise<CounterpartyInfo[]> {
  const baseRate = await fetchRateFromHorizon(sell, buy);

  const history = await leerHistorialAcotado(DEMO_AGENT_ADDRESS);

  const completionRate = history && history.broadcasts > 0
    ? parseFloat((history.swaps_completed / history.broadcasts).toFixed(3))
    : null;

  const counterparties: CounterpartyInfo[] = [
    {
      address: DEMO_AGENT_ADDRESS,
      chain: "stellar",
      completion_rate: completionRate,
      swaps_completed: history?.swaps_completed ?? null,
      // No se mide en ningun lado todavia. null hasta que exista.
      avg_time_seconds: null,
      available_amount: DEMO_AVAILABLE_AMOUNT,
      available_amount_source: "estimate",
      rate: (baseRate * 0.999).toFixed(4), // best rate (0.1% spread)
      source: "demo",
    },
  ];

  return counterparties.filter((c) => !amount || parseFloat(c.available_amount) >= parseFloat(amount));
}

export async function swapRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/v1/swaps/search
   * x402: $0.001 — find available swap counterparties with live Horizon rates
   */
  fastify.get(
    "/api/v1/swaps/search",
    { preHandler: requirePayment({ amount: "0.001", service: "swap_search" }) },
    async (request, reply) => {
      const { sell_asset, buy_asset, amount } = request.query as {
        sell_asset?: string;
        buy_asset?: string;
        amount?: string;
      };

      const sell = (sell_asset ?? "USDC").toUpperCase();
      const buy  = (buy_asset  ?? "XLM").toUpperCase();

      const [counterparties, marketRate] = await Promise.all([
        buildCounterparties(sell, buy, amount),
        fetchRateFromHorizon(sell, buy),
      ]);

      return reply.send({
        counterparties,
        sell_asset: sell,
        buy_asset: buy,
        market_rate: marketRate.toFixed(4),
        rate_source: "horizon-testnet",
        // La misma honestidad que ya tenia `rate`, para el resto de los campos.
        reputation_source: "agent_history",
        total_results: counterparties.length,
        payer: request.payerAddress,
      });
    }
  );

  /**
   * GET /api/v1/swaps/:id/status
   * x402: $0.0001 — poll swap status
   */
  fastify.get(
    "/api/v1/swaps/:id/status",
    { preHandler: requirePayment({ amount: "0.0001", service: "swap_status" }) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const swap = swapStore.get(id);

      if (!swap) {
        return reply.status(404).send({ error: "Swap not found", swap_id: id });
      }

      // Cada tx a su explorador: la pierna A es Soroban, la B es XRPL
      const txLinks: Record<string, string> = {};
      for (const [key, hash] of Object.entries(swap.txs)) {
        if (hash) txLinks[key] = txLink(key as keyof SwapState["txs"], hash);
      }

      return reply.send({
        swap_id:    swap.swap_id,
        plan_id:    swap.plan_id,
        status:     swap.status,
        sell:       `${swap.sell_amount} ${swap.sell_asset}`,
        buy:        `${swap.buy_amount} ${swap.buy_asset}`,
        secret_hash: swap.secret_hash,
        chain_a:    "stellar",
        chain_b:    swap.chain_b,
        // owner + offer_sequence identifican el escrow en XRPL: sin los dos no
        // se puede ni completar ni cancelar. Se exponen para que un operador
        // pueda actuar sobre la pierna B sin entrar al proceso.
        xrpl:       swap.xrpl,
        txs:        swap.txs,
        tx_links:   txLinks,
        error:      swap.error,
        created_at: swap.created_at,
        updated_at: swap.updated_at,
      });
    }
  );

  /**
   * GET /api/v1/swaps/pending-refunds
   * Gratis a propósito: cobrar por saber que tienes dinero atrapado sería
   * exactamente el incentivo equivocado.
   */
  fastify.get("/api/v1/swaps/pending-refunds", async (_request, reply) => {
    const pendientes = pendingRefunds();
    return reply.send({
      count: pendientes.length,
      swaps: pendientes.map((s) => ({
        swap_id: s.swap_id,
        status: s.status,
        error: s.error,
        locked: { soroban: s.txs.lock_a, xrpl: s.txs.lock_b },
        xrpl: s.xrpl,
        updated_at: s.updated_at,
      })),
      hint: "POST /api/v1/swaps/:id/refund. Las dos cadenas solo reembolsan pasado el timeout.",
    });
  });

  /**
   * POST /api/v1/swaps/:id/refund
   *
   * Sin x402: si un swap dejó fondos bloqueados, cobrar por devolverlos es
   * indefendible. Idempotente — se puede reintentar hasta que las dos piernas
   * queden resueltas, porque ninguna cadena permite reembolsar antes de su
   * timeout.
   */
  fastify.post("/api/v1/swaps/:id/refund", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!swapStore.get(id)) {
      return reply.status(404).send({ error: "Swap not found", swap_id: id });
    }

    const initiatorSecret = process.env.PLATFORM_SECRET_KEY;
    const xrplCounterpartySeed = process.env.XRPL_COUNTERPARTY_SEED;
    const xrplInitiatorSeed = process.env.XRPL_INITIATOR_SEED;
    if (!initiatorSecret || !xrplCounterpartySeed || !xrplInitiatorSeed) {
      return reply.status(503).send({ error: "Demo keypairs not configured" });
    }

    try {
      const result = await refundSwap(id, initiatorSecret, CONTRACT_A, {
        initiatorSeed: xrplInitiatorSeed,
        counterpartySeed: xrplCounterpartySeed,
      });
      return reply.send({
        ...result,
        // pending no es un error: lo normal es que el timeout aún no haya
        // pasado. Se reintenta más tarde.
        retry_after_timeout: result.pending.length > 0,
      });
    } catch (err) {
      return reply.status(500).send({ error: "Refund failed", detail: String(err) });
    }
  });
}
