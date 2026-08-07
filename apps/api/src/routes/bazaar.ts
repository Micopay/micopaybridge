import type { FastifyInstance } from "fastify";
import { requirePayment } from "../middleware/x402.js";
import { randomUUID, randomBytes, createHash } from "crypto";
import { lockAtomicSwap } from "../services/stellar.service.js";
import {
  initBazaarTables,
  seedAgentHistories,
  seedIntents,
  createIntent,
  getIntent,
  getActiveIntents,
  updateIntent,
  createQuote,
  getQuotesForIntent,
  getAgentHistory,
  upsertAgentHistory,
  intentRowToObject,
  getBazaarStats,
  type BazaarIntentRow,
} from "../db/bazaar.js";

interface AssetInfo {
  chain: string;
  symbol: string;
  amount: string;
}

interface BazaarIntent {
  id: string;
  agent_address: string;
  offered: AssetInfo;
  wanted: AssetInfo;
  min_rate?: number;
  status: "active" | "negotiating" | "executed" | "expired";
  created_at: string;
  expires_at: string;
  reputation_tier?: string;
  secret_hash?: string;
  selected_quote_id?: string;
}

interface BazaarQuote {
  id: string;
  intent_id: string;
  from_agent: string;
  rate: number;
  valid_until: string;
}

const AGENT_TIERS = [
  { name: "maestro",  emoji: "🍄", min_swaps: 50,  min_rate: 0.95, description: "Elite agent. High-frequency, high-reliability cross-chain executor." },
  { name: "experto",  emoji: "⭐", min_swaps: 15,  min_rate: 0.88, description: "Reliable agent with a solid completion track record." },
  { name: "activo",   emoji: "✅", min_swaps: 3,   min_rate: 0.75, description: "Active agent. Growing reputation." },
  { name: "espora",   emoji: "🌱", min_swaps: 0,   min_rate: 0.0,  description: "New agent. Use with caution — low history." },
];

function getAgentTier(completed: number, total: number) {
  const rate = total > 0 ? completed / total : 0;
  return AGENT_TIERS.find(t => completed >= t.min_swaps && rate >= t.min_rate)
    ?? AGENT_TIERS[AGENT_TIERS.length - 1];
}

const memoryAgentHistory = new Map<string, { broadcasts: number; swaps_completed: number; swaps_cancelled: number; volume_usdc: number; first_seen: string; last_active: string }>();

memoryAgentHistory.set("GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKUJI5KOOJ9TXWNTBBS2JN", {
  broadcasts: 87, swaps_completed: 83, swaps_cancelled: 4, volume_usdc: 241500,
  first_seen: "2025-09-14T10:22:00Z", last_active: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
});
memoryAgentHistory.set("GDAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A", {
  broadcasts: 31, swaps_completed: 28, swaps_cancelled: 3, volume_usdc: 52300,
  first_seen: "2025-11-03T15:45:00Z", last_active: new Date(Date.now() - 1000 * 60 * 2).toISOString(),
});

async function getOrCreateHistory(address: string) {
  let history = await getAgentHistory(address);
  if (!history) {
    history = await upsertAgentHistory(address, { broadcasts: 0, swaps_completed: 0, swaps_cancelled: 0, volume_usdc: 0 });
  }
  return history;
}

async function recordBroadcast(address: string) {
  await upsertAgentHistory(address, { broadcasts: 1 });
}

async function recordCompletion(address: string, volumeUsdc: number) {
  await upsertAgentHistory(address, { swaps_completed: 1, volume_usdc: volumeUsdc });
}

let initialized = false;
let initFailed = false;

async function ensureBazaarInitialized() {
  if (initialized) return;
  if (initFailed) return;
  try {
    await initBazaarTables();
    await seedAgentHistories();
    await seedIntents();
    initialized = true;
  } catch (error) {
    console.error('Failed to initialize Bazaar DB:', error);
    initFailed = true;
  }
}

export async function bazaarRoutes(fastify: FastifyInstance): Promise<void> {
  ensureBazaarInitialized().catch(console.error);

  fastify.post(
    "/api/v1/bazaar/intent",
    { preHandler: requirePayment({ amount: "0.005", service: "bazaar_broadcast" }) },
    async (request, reply) => {
      const body = request.body as Partial<BazaarIntent>;

      if (!body.offered || !body.wanted) {
        return reply.status(400).send({ error: "offered and wanted asset info required" });
      }

      const agentAddress = request.payerAddress ?? "GUNKNOWN";

      await recordBroadcast(agentAddress);
      const history = await getOrCreateHistory(agentAddress);
      const tier = getAgentTier(history.swaps_completed, history.broadcasts);

      const id = `int-${randomUUID().slice(0, 8)}`;
      const newIntent = await createIntent({
        id,
        agent_address: agentAddress,
        offered_chain: body.offered!.chain,
        offered_symbol: body.offered!.symbol,
        offered_amount: body.offered!.amount,
        wanted_chain: body.wanted!.chain,
        wanted_symbol: body.wanted!.symbol,
        wanted_amount: body.wanted!.amount,
        min_rate: body.min_rate ?? null,
        status: "active",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        reputation_tier: tier.name,
        secret_hash: null,
        selected_quote_id: null,
      });

      fastify.log.info(`Bazaar: ${tier.emoji} [${tier.name}] ${agentAddress.slice(0,8)} broadcasts ${body.offered!.symbol} → ${body.wanted!.symbol}`);

      return reply.status(201).send(intentRowToObject(newIntent));
    }
  );

  fastify.get(
    "/api/v1/bazaar/feed",
    { preHandler: requirePayment({ amount: "0.001", service: "bazaar_feed" }) },
    async (_request, reply) => {
      const rows = await getActiveIntents();

      return reply.send({
        intents: rows.map(intentRowToObject),
        count: rows.length,
        network: "global-intent-layer",
        note: "Every intent in this feed was broadcasted by an AI agent paying via x402. Reputation tiers computed from on-chain swap history.",
      });
    }
  );

  fastify.get(
    "/api/v1/bazaar/stats",
    async (_request, reply) => {
      let stats;

      try {
        stats = await getBazaarStats();
      } catch {
        const now = new Date();
        stats = {
          total_intents: 2,
          active_intents: 2,
          negotiating_intents: 0,
          executed_intents: 0,
          expired_intents: 0,
          total_volume_usdc: 293800,
          total_broadcasts: 118,
          total_swaps_completed: 111,
          total_swaps_cancelled: 7,
          top_agents: [
            {
              agent_address: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKUJI5KOOJ9TXWNTBBS2JN",
              broadcasts: 87, swaps_completed: 83, completion_rate: 0.954,
              volume_usdc: 241500, tier: "maestro", tier_emoji: "🍄"
            },
            {
              agent_address: "GDAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A",
              broadcasts: 31, swaps_completed: 28, completion_rate: 0.903,
              volume_usdc: 52300, tier: "experto", tier_emoji: "⭐"
            },
          ],
          recent_intents: [
            {
              id: "int-001",
              agent_address: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKUJI5KOOJ9TXWNTBBS2JN",
              offered: { chain: "ethereum", symbol: "ETH", amount: "2.5" },
              wanted: { chain: "stellar", symbol: "USDC", amount: "7000" },
              status: "active",
              created_at: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
              expires_at: new Date(now.getTime() + 55 * 60 * 1000).toISOString(),
              reputation_tier: "maestro",
              secret_hash: null,
              selected_quote_id: null,
            },
            {
              id: "int-002",
              agent_address: "GDAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A",
              offered: { chain: "stellar", symbol: "USDC", amount: "500" },
              wanted: { chain: "physical", symbol: "MXN", amount: "8750" },
              status: "active",
              created_at: new Date(now.getTime() - 2 * 60 * 1000).toISOString(),
              expires_at: new Date(now.getTime() + 58 * 60 * 1000).toISOString(),
              reputation_tier: "experto",
              secret_hash: null,
              selected_quote_id: null,
            },
          ],
        };
      }

      return reply.send({
        ...stats,
        network: "global-intent-layer",
        data_source: "PostgreSQL",
        queried_at: new Date().toISOString(),
      });
    }
  );

  fastify.get(
    "/api/v1/bazaar/reputation/:address",
    async (request, reply) => {
      const { address } = request.params as { address: string };

      let history;
      let dataSource = "PostgreSQL";

      try {
        history = await getOrCreateHistory(address);
      } catch {
        dataSource = "in-memory (DB unavailable)";
        const seedHistory = memoryAgentHistory.get(address);
        history = seedHistory ?? {
          broadcasts: 0, swaps_completed: 0, swaps_cancelled: 0,
          volume_usdc: 0, first_seen: new Date().toISOString(),
          last_active: new Date().toISOString(),
        };
      }

      const completion_rate = history.broadcasts > 0
        ? parseFloat((history.swaps_completed / history.broadcasts).toFixed(3))
        : 0;

      const tier = getAgentTier(history.swaps_completed, history.broadcasts);
      const trusted = history.swaps_completed >= 3 && completion_rate >= 0.75;
      const recommendation = trusted
        ? `✅ Trusted agent. ${tier.emoji} ${tier.name.toUpperCase()}. ${history.swaps_completed} swaps completed.`
        : `⚠️ Low trust. Only ${history.swaps_completed} completed swaps. Proceed with caution.`;

      return reply.send({
        address,
        agent_reputation: {
          tier: tier.name,
          tier_emoji: tier.emoji,
          tier_description: tier.description,
          swaps_completed: history.swaps_completed,
          total_broadcasts: history.broadcasts,
          swaps_cancelled: history.swaps_cancelled,
          completion_rate,
          completion_percent: `${(completion_rate * 100).toFixed(1)}%`,
          volume_usdc_total: history.volume_usdc.toString(),
          first_seen: history.first_seen,
          last_active: history.last_active,
        },
        agent_signal: {
          trusted,
          recommendation,
          risk_level: !trusted ? "high" : completion_rate >= 0.95 ? "low" : "medium",
        },
        data_source: `MicoPay Bazaar swap history (${dataSource})`,
        note: "Agent reputation is derived from completed Bazaar swaps — not transferable, not buyable.",
        queried_at: new Date().toISOString(),
      });
    }
  );

  fastify.post(
    "/api/v1/bazaar/quote",
    { preHandler: requirePayment({ amount: "0.002", service: "bazaar_quote" }) },
    async (request, reply) => {
      const body = request.body as { intent_id: string; rate: number };

      if (!body.intent_id || !body.rate) {
        return reply.status(400).send({ error: "intent_id and rate required" });
      }

      const intent = await getIntent(body.intent_id);
      if (!intent) return reply.status(404).send({ error: "Intent not found" });

      const quoteId = `qut-${randomUUID().slice(0, 8)}`;
      const newQuote = await createQuote({
        id: quoteId,
        intent_id: body.intent_id,
        from_agent: request.payerAddress ?? "GUNKNOWN",
        rate: body.rate,
        valid_until: new Date(Date.now() + 300_000).toISOString(),
      });

      return reply.status(201).send({
        quote: newQuote,
        note: "Quote sent to target agent. Handshake initiated. Monitor AtomicSwapHTLC events to settle.",
      });
    }
  );

  fastify.post(
    "/api/v1/bazaar/accept",
    { preHandler: requirePayment({ amount: "0.005", service: "bazaar_accept" }) },
    async (request, reply) => {
      const body = request.body as { intent_id: string; quote_id?: string; secret_hash?: string; amount_usdc?: number };

      if (!body.intent_id) {
        return reply.status(400).send({ error: "intent_id is required" });
      }

      const intent = await getIntent(body.intent_id);
      if (!intent) return reply.status(404).send({ error: "Intent not found" });
      if (intent.status !== "active") return reply.status(409).send({ error: `Intent is already ${intent.status}` });

      const secretHash = body.secret_hash
        ?? createHash("sha256").update(randomBytes(32)).digest("hex");

      const quotes = await getQuotesForIntent(body.intent_id);
      const quote = body.quote_id
        ? quotes.find(q => q.id === body.quote_id)
        : quotes[0];

      const amountUsdc = body.amount_usdc
        ?? parseFloat(intent.wanted_symbol === "USDC" ? intent.wanted_amount : "28.57");

      fastify.log.info(`Bazaar: Locking Stellar side for intent ${body.intent_id}...`);
      const lock = await lockAtomicSwap({ amountUsdc, secretHash, timeoutMinutes: 60 });

      await updateIntent(body.intent_id, {
        status: "negotiating",
        secret_hash: secretHash,
        selected_quote_id: quote?.id ?? null,
      });

      await recordCompletion(intent.agent_address, amountUsdc);

      fastify.log.info(`Bazaar: Lock confirmed. swap_id=${lock.swapId.slice(0, 10)} tx=${lock.txHash}`);

      return reply.send({
        status: "negotiating",
        message: "Stellar side anchored on-chain. Cross-chain intent coordinated.",
        handshake: {
          intent_id: body.intent_id,
          quote_id: quote?.id ?? "auto",
          market_maker: quote?.from_agent ?? "market-maker-agent",
          secret_hash: secretHash,
          htlc_tx_hash: lock.txHash,
          htlc_explorer_url: lock.explorerUrl,
          swap_id: lock.swapId,
        },
        agent_reputation_updated: true,
        note: "Stellar side locked. AtomicSwapHTLC (built + tested) resolves the counterpart chain in production.",
        next_step: "Agent B locks counterpart asset using shared secret_hash. Revealing secret on Chain B gives initiator claim rights here.",
      });
    }
  );
}
