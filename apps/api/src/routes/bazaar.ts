import type { FastifyInstance } from "fastify";
import { requirePayment } from "../middleware/x402.js";
import { randomUUID } from "crypto";
import { lockAtomicSwap } from "../services/stellar.service.js";
import {
  initBazaarTables,
  seedIntents,
  createIntent,
  getIntent,
  getActiveIntents,
  updateIntent,
  createQuote,
  getQuote,
  getQuotesForIntent,
  getAgentHistory,
  upsertAgentHistory,
  intentRowToObject,
  getBazaarStats,
  type BazaarIntentRow,
  type BazaarQuoteRow,
  type AgentHistoryRow,
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

// #33 (BRIDGE-16): este Map llevaba los mismos dos agentes inventados del
// seed, y servia cuando la base de datos no estaba disponible — el camino
// degradado publicaba cifras fabricadas con el mismo formato que las reales.
// Se conserva como almacen vacio (lo escriben los broadcasts reales) pero no
// se pre-carga con nadie: un agente sin historial se reporta como sin
// historial, no como maestro.
const memoryAgentHistory = new Map<string, { broadcasts: number; swaps_completed: number; swaps_cancelled: number; volume_usdc: number; first_seen: string; last_active: string }>();

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

let initialized = false;
let initFailed = false;

async function ensureBazaarInitialized() {
  if (initialized) return;
  if (initFailed) return;
  try {
    await initBazaarTables();
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

      let degraded = false;

      try {
        stats = await getBazaarStats();
      } catch {
        // #33 (BRIDGE-16): este catch devolia los mismos numeros inventados
        // del seed (293800 / 118 / 111 y los dos agentes "top"). Con la base
        // de datos caida no se publica ninguna cifra que pueda parecer
        // medida: ceros estructurales, listas vacias y la bandera explicita.
        degraded = true;
        stats = {
          total_intents: 0,
          active_intents: 0,
          negotiating_intents: 0,
          executed_intents: 0,
          expired_intents: 0,
          total_volume_usdc: 0,
          total_broadcasts: 0,
          total_swaps_completed: 0,
          total_swaps_cancelled: 0,
          top_agents: [],
          recent_intents: [],
          reputation_status: "no_settlement_data",
          reputation_note:
            "stats unavailable: database unreachable; no substitute figures are served (BRIDGE-16)",
        };
      }

      return reply.send({
        ...stats,
        network: "global-intent-layer",
        data_source: degraded ? "unavailable (degraded)" : "PostgreSQL",
        queried_at: new Date().toISOString(),
      });
    }
  );

  fastify.get(
    "/api/v1/bazaar/reputation/:address",
    async (request, reply) => {
      const { address } = request.params as { address: string };

      // #33 (BRIDGE-16): antes, un agente sin historial recibia uno de ceros
      // fabricado en el momento (fila creada al leer, o literal inventado si
      // la base de datos estaba caida) con el mismo formato que un historial
      // computado. Ahora la ausencia se describe a si misma y distingue sus
      // dos causas: sin fila ("no_recorded_history") o sin base de datos
      // ("db_unavailable"). Un cero solo aparece cuando hay fila — actividad
      // real que aun no incluye swaps, porque el bazaar no tiene settlement.
      // Subset común entre la fila de la base de datos y la entrada en
      // memoria: todo lo que el cálculo de tier lee está aquí.
      type HistoryView = Pick<AgentHistoryRow,
        'broadcasts' | 'swaps_completed' | 'swaps_cancelled' | 'volume_usdc' | 'first_seen' | 'last_active'>;

      let history: HistoryView | null = null;
      let degraded = false;

      try {
        history = await getAgentHistory(address);
      } catch {
        degraded = true;
        history = memoryAgentHistory.get(address) ?? null;
      }

      const queried_at = new Date().toISOString();

      if (!history) {
        const reason = degraded ? "db_unavailable" : "no_recorded_history";
        const recommendation = degraded
          ? "History unavailable: the database cannot be reached and no in-memory activity exists for this address. Nothing is inferred from absence."
          : "No recorded activity for this address. A history row appears when an agent broadcasts its first intent; none exists yet.";
        return reply.send({
          address,
          history_available: false,
          reason,
          agent_reputation: null,
          agent_signal: {
            trusted: false,
            recommendation,
            risk_level: "high",
          },
          data_source: degraded
            ? "MicoPay Bazaar swap history (DB unreachable; no in-memory activity for this address)"
            : "MicoPay Bazaar swap history (no row for this address)",
          note: "Agent reputation is derived from completed Bazaar swaps — not transferable, not buyable. Absence of history is reported as absence, never as a computed zero (BRIDGE-16).",
          queried_at,
        });
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
        history_available: true,
        degraded,
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
        data_source: `MicoPay Bazaar swap history (${degraded ? "in-memory, DB unavailable" : "PostgreSQL"})`,
        note: "Agent reputation is derived from completed Bazaar swaps — not transferable, not buyable.",
        queried_at,
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
    {
      preHandler: requirePayment({ amount: "0.005", service: "bazaar_accept" }),
      schema: {
        body: {
          type: "object",
          required: ["secret_hash"],
          properties: {
            intent_id: { type: "string", minLength: 1 },
            quote_id: { type: "string" },
            // sha256(preimagen) en hexadecimal minuscula. El patron cubre
            // longitud, alfabeto y caja en un solo lugar, en el borde HTTP.
            secret_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
            amount_usdc: { type: "number", exclusiveMinimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { intent_id: string; quote_id?: string; secret_hash?: string; amount_usdc?: number };

      if (!body.intent_id) {
        return reply.status(400).send({ error: "intent_id is required" });
      }

      const intent = await getIntent(body.intent_id);
      if (!intent) return reply.status(404).send({ error: "Intent not found" });
      if (intent.status !== "active") return reply.status(409).send({ error: `Intent is already ${intent.status}` });

      // Validado por el schema de la ruta: presente y 64 hex en minuscula.
      // El servidor nunca genera la preimagen: en un protocolo no custodial la
      // genera el iniciador y se la queda. El servidor solo ve el hash.
      const secretHash = body.secret_hash as string;

      // ── Puertas de #8. Todas ANTES del lock: rechazar despues de bloquear
      // fondos deja el escrow colgado sin nadie que lo libere.

      // Aceptarse a uno mismo cuesta $0.005 y no entrega nada. Sin esto, un
      // agente publica y acepta sus propios intents para fabricarse historial.
      const acceptor = request.payerAddress ?? "GUNKNOWN";
      if (acceptor === intent.agent_address) {
        return reply.status(403).send({
          error: "self_acceptance_forbidden",
          message: "An agent cannot accept its own intent.",
        });
      }

      // `expires_at` es NOT NULL en la tabla; si aun asi no se puede leer, se
      // trata como vencido. Esto es una puerta de liquidacion: ante la duda
      // sobre si el intent sigue vivo, no se bloquean fondos.
      const expiresAt = Date.parse(intent.expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return reply.status(409).send({
          error: "intent_expired",
          message: "This intent has expired and can no longer be accepted.",
          expires_at: intent.expires_at,
        });
      }

      // pg devuelve DECIMAL como string (rate es DECIMAL(10,6), min_rate
      // DECIMAL(5,4)). Sin convertir, `"0.9" < "0.95"` compara lexicograficamente
      // y da lo contrario de lo que parece — el mismo fallo que ya costo un
      // arreglo en volume_usdc.
      const rateOf = (q: BazaarQuoteRow): number => Number(q.rate);
      const quoteVigente = (q: BazaarQuoteRow): boolean => {
        const validUntil = Date.parse(q.valid_until);
        return Number.isFinite(validUntil) && validUntil > Date.now();
      };

      let quote: BazaarQuoteRow | undefined;
      if (body.quote_id) {
        // Se busca por id, no dentro de las del intent: si solo mirasemos la
        // lista del intent, "no existe" y "es de otro intent" darian lo mismo.
        const candidata = await getQuote(body.quote_id);
        if (!candidata) {
          return reply.status(404).send({
            error: "quote_not_found",
            message: `No quote exists with id ${body.quote_id}.`,
          });
        }
        if (candidata.intent_id !== body.intent_id) {
          return reply.status(409).send({
            error: "quote_intent_mismatch",
            message: `Quote ${candidata.id} belongs to intent ${candidata.intent_id}, not ${body.intent_id}.`,
          });
        }
        if (!quoteVigente(candidata)) {
          return reply.status(409).send({
            error: "quote_expired",
            message: `Quote ${candidata.id} expired at ${candidata.valid_until}.`,
          });
        }
        quote = candidata;
      } else {
        const vigentes = (await getQuotesForIntent(body.intent_id)).filter(quoteVigente);
        if (vigentes.length === 0) {
          return reply.status(409).send({
            error: "no_valid_quote",
            message: "This intent has no quote that is still valid. Send a quote first.",
          });
        }
        // "Mejor" = rate mas alto. El rate es cuanto de lo que pide recibe el
        // autor del intent por lo que ofrece, asi que el mas alto es el mas
        // favorable para el, que es quien publico. Antes se cogia quotes[0]
        // —la primera que llego, ordenada por fecha— que no es una eleccion,
        // es un accidente.
        quote = vigentes.reduce((mejor, q) => (rateOf(q) > rateOf(mejor) ? q : mejor));
      }

      // El `min_rate` del intent se guardaba y no lo leia nadie. Es el suelo
      // que puso el autor: por debajo, no hay trato.
      if (intent.min_rate !== null && intent.min_rate !== undefined) {
        const minRate = Number(intent.min_rate);
        if (Number.isFinite(minRate) && rateOf(quote) < minRate) {
          return reply.status(409).send({
            error: "quote_below_min_rate",
            message: `Quote rate ${rateOf(quote)} is below the intent's min_rate ${minRate}.`,
          });
        }
      }

      // Se deriva del intent. El "28.57" que habia aqui era un numero inventado
      // que se colaba en un escrow real en cuanto el intent no pedia USDC.
      // Solo hacen falta los dos lados del intent: si una de las patas ES USDC,
      // esa es la cantidad; si ninguna lo es, no hay importe en USDC que
      // derivar y el rate de la quote no lo inventa.
      //
      // `amount_usdc` del body se sigue respetando como override explicito.
      // Contrastarlo contra el importe derivado —y con lo que de verdad se
      // bloquea— es #14, que toca justo esa parte.
      const derivado =
        intent.wanted_symbol === "USDC" ? Number(intent.wanted_amount)
        : intent.offered_symbol === "USDC" ? Number(intent.offered_amount)
        : null;

      const amountUsdc = body.amount_usdc ?? derivado;
      if (amountUsdc === null || !Number.isFinite(amountUsdc) || amountUsdc <= 0) {
        return reply.status(400).send({
          error: "amount_not_derivable",
          message:
            "Neither side of this intent is denominated in USDC, so the escrow amount cannot be derived. Send amount_usdc explicitly.",
        });
      }

      fastify.log.info(`Bazaar: Locking Stellar side for intent ${body.intent_id}...`);

      // El lock tiene que confirmarse antes de tocar cualquier estado. Si falla,
      // el intent queda como estaba y no se registra reputacion: no hubo swap.
      let lock: Awaited<ReturnType<typeof lockAtomicSwap>>;
      try {
        lock = await lockAtomicSwap({ amountUsdc, secretHash, timeoutMinutes: 60 });
      } catch (err: any) {
        const reason = err?.message ?? String(err);
        fastify.log.error(`Bazaar: on-chain lock failed for intent ${body.intent_id}: ${reason}`);
        return reply.status(502).send({
          error: "On-chain lock failed",
          message: "No funds were locked. The intent was not modified.",
          intent_id: body.intent_id,
          intent_status: intent.status,
          reason,
        });
      }

      await updateIntent(body.intent_id, {
        status: "negotiating",
        secret_hash: secretHash,
        selected_quote_id: quote.id,
      });

      // Accept only establishes the first on-chain lock; it is not settlement.
      // Do not increment swaps_completed or volume_usdc here. Once settlement
      // confirmation exists, credit both the intent author and the acceptor with
      // the amount actually settled. See BRIDGE-08 / issue #15.

      fastify.log.info(`Bazaar: Lock confirmed. swap_id=${lock.swapId.slice(0, 10)} tx=${lock.txHash}`);

      return reply.send({
        status: "negotiating",
        message: "Stellar side anchored on-chain. Cross-chain intent coordinated.",
        handshake: {
          intent_id: body.intent_id,
          quote_id: quote.id,
          market_maker: quote.from_agent,
          rate: rateOf(quote),
          secret_hash: secretHash,
          htlc_tx_hash: lock.txHash,
          htlc_explorer_url: lock.explorerUrl,
          swap_id: lock.swapId,
        },
        agent_reputation_updated: false,
        reputation_update: "deferred_until_settlement",
        // La pierna contraria ya no es "en producción": es un escrow nativo de
        // XRPL y corre en POST /api/v1/swaps/execute (§M4.5 del plan).
        note: "Stellar side locked. The counterpart leg runs as a native XRPL escrow (PREIMAGE-SHA-256 + CancelAfter) — see POST /api/v1/swaps/execute.",
        next_step: "Agent B locks XRP with an EscrowCreate carrying the same secret_hash. Revealing the preimage on XRPL gives the initiator claim rights here.",
      });
    }
  );
}
