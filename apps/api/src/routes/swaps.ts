import type { FastifyInstance } from "fastify";
import { requirePayment } from "../middleware/x402.js";
import type { CounterpartyInfo } from "@micopay/types";
import { swapStore } from "../lib/swapStore.js";

const EXPLORER = "https://stellar.expert/explorer/testnet/tx";

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

async function buildCounterparties(sell: string, buy: string, amount?: string): Promise<CounterpartyInfo[]> {
  const baseRate = await fetchRateFromHorizon(sell, buy);
  return [
    {
      address: "GDEMOSWAP1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      chain: "stellar",
      completion_rate: 0.98,
      avg_time_seconds: 45,
      available_amount: "10000",
      rate: (baseRate * 0.999).toFixed(4), // best rate (0.1% spread)
    },
    {
      address: "GDEMOSWAP2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      chain: "stellar",
      completion_rate: 0.94,
      avg_time_seconds: 62,
      available_amount: "5000",
      rate: (baseRate * 0.995).toFixed(4), // slightly worse
    },
  ].filter((c) => !amount || parseFloat(c.available_amount) >= parseFloat(amount));
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

      // Attach stellar.expert links for any confirmed txs
      const txLinks: Record<string, string> = {};
      for (const [key, hash] of Object.entries(swap.txs)) {
        if (hash) txLinks[key] = `${EXPLORER}/${hash}`;
      }

      return reply.send({
        swap_id:    swap.swap_id,
        plan_id:    swap.plan_id,
        status:     swap.status,
        sell:       `${swap.sell_amount} ${swap.sell_asset}`,
        buy:        `${swap.buy_amount} ${swap.buy_asset}`,
        secret_hash: swap.secret_hash,
        txs:        swap.txs,
        tx_links:   txLinks,
        error:      swap.error,
        created_at: swap.created_at,
        updated_at: swap.updated_at,
      });
    }
  );
}
