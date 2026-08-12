import type { FastifyInstance } from "fastify";
import { requirePayment } from "../middleware/x402.js";
import { query } from "../db/schema.js";
// La frontera del §M3 vive entera en lib/reputation-source.ts: esta ruta no
// sabe si los datos llegan del endpoint interno del backend móvil (opción b,
// la recomendada) o de leer su misma base (opción a, el respaldo de hoy).
import { getReputationSource, type MerchantReputation } from "../lib/reputation-source.js";

// ── Tier definitions ─────────────────────────────────────────────────────────
const TIERS = [
  { name: "maestro", emoji: "🍄", minTrades: 100, minCompletion: 0.95, description: "Top-tier merchant. Trusted by AI agents." },
  { name: "experto", emoji: "⭐", minTrades: 30, minCompletion: 0.88, description: "Reliable merchant with solid track record." },
  { name: "activo", emoji: "✅", minTrades: 10, minCompletion: 0.80, description: "Active merchant. Growing reputation." },
  { name: "espora", emoji: "🌱", minTrades: 0, minCompletion: 0.0, description: "New merchant. Use with caution." },
];

function getTier(trades: number, completion: number) {
  return TIERS.find((t) => trades >= t.minTrades && completion >= t.minCompletion) ?? TIERS[TIERS.length - 1];
}

/**
 * Estas rutas sirven reputación de **comercios de MicoPay**, que es otra cosa
 * que la reputación de agentes del bazaar: esa vive en `agent_history` (ver
 * `db/bazaar.ts`), se calcula sola con los swaps del propio mercado y no
 * depende de nadie.
 *
 * La de comercios solo tiene sentido cuando el bazaar se conecte a la red de
 * efectivo de MicoPay. Mientras tanto la tabla `merchants` de este repo está
 * vacía —o con datos sembrados—, así que un agente que pagara por preguntar
 * "¿me fío de este comercio?" recibiría o nada o números inventados sobre
 * comercios que no existen. En un servicio público eso es peor que un 501.
 *
 * Se apagan por defecto, no se borran: la implementación queda íntegra detrás
 * de la bandera y el contrato del lado servidor está en
 * `docs/CONTRATO_REPUTACION.md`.
 */
const NO_DISPONIBLE = {
  error: "Not Implemented",
  code: "MERCHANT_REPUTATION_UNAVAILABLE",
  message:
    "La reputación de comercios requiere la conexión con la red de efectivo de MicoPay, " +
    "que todavía no existe. La reputación de agentes del bazaar sí está disponible y no " +
    "depende de esto.",
  hint: "Se habilita con MICOPAY_CASH_NETWORK_ENABLED=true una vez exista la fuente de datos.",
};

export async function reputationRoutes(fastify: FastifyInstance): Promise<void> {
  // Se lee al registrar y no al cargar el módulo: así el estado del proceso no
  // queda congelado en la primera importación, y los tests pueden ejercitar
  // los dos modos sin trucos con la caché de módulos.
  const redEfectivoConectada = process.env.MICOPAY_CASH_NETWORK_ENABLED === "true";

  if (!redEfectivoConectada) {
    // Sin `requirePayment` a propósito: nadie debe pagar x402 por un endpoint
    // que no va a responder. Cobrar y devolver 501 sería cobrar por nada.
    fastify.get("/api/v1/reputation/:address", async (_request, reply) =>
      reply.status(501).send(NO_DISPONIBLE),
    );
    fastify.get("/api/v1/merchants", async (_request, reply) =>
      reply.status(501).send(NO_DISPONIBLE),
    );
    fastify.log.warn(
      { category: "reputation" },
      "[reputacion] rutas de comercios apagadas (MICOPAY_CASH_NETWORK_ENABLED != true)",
    );
    return;
  }

  /**
   * GET /api/v1/reputation/:address
   * x402: $0.0005 USDC
   *
   * Returns the on-chain reputation of a MicoPay merchant.
   * The reputation is derived from completed trades recorded on Stellar
   * and an optional NFT soulbound badge that cannot be transferred.
   *
   * AI agents use this to decide whether to trust a merchant before
   * initiating a cash exchange on behalf of a user.
   */
  fastify.get(
    "/api/v1/reputation/:address",
    { preHandler: requirePayment({ amount: "0.0005", service: "reputation" }) },
    async (request, reply) => {
      const { address } = request.params as { address: string };

      // Basic Stellar address validation
      if (!address.startsWith("G") || address.length !== 56) {
        return reply.status(400).send({
          error: "Invalid Stellar address",
          hint: "Stellar addresses start with G and are 56 characters long",
        });
      }

      // La consulta que había aquí NO filtraba por la dirección pedida:
      // ordenaba por verified_at y devolvía el primero. Cualquier dirección
      // válida obtenía siempre el mismo comercio, así que un agente que
      // pagaba por saber si fiarse del comercio X recibía los números del
      // comercio Y — en la ruta cuya única función es informar esa decisión.
      let merchant: MerchantReputation | null;
      try {
        merchant = await getReputationSource().byAddress(address);
      } catch (err) {
        // Que la fuente de reputación esté caída no es un 404: un 404 diría
        // "este comercio no es de fiar", que es una respuesta distinta y
        // peligrosa. Se dice que no se sabe.
        return reply.status(503).send({
          error: "Reputation source unavailable",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      if (!merchant) {
        return reply.status(404).send({
          error: "No verified merchant found",
          hint: "This Stellar address does not correspond to a verified merchant",
          address,
        });
      }

      const tradesCompleted = merchant.trades_completed;
      const completionRate = merchant.completion_rate;
      const tier = getTier(tradesCompleted, completionRate);

      // Agent-friendly decision signal
      const trusted = completionRate >= 0.88 && tradesCompleted >= 10;
      const recommendation = trusted
        ? `✅ Trusted. ${tier.emoji} ${tier.name.toUpperCase()} merchant. Send user with confidence.`
        : `⚠️ Low trust. Only ${tradesCompleted} trades, ${(completionRate * 100).toFixed(0)}% completion. Consider alternatives.`;

      return reply.send({
        address: merchant.stellar_address,
        merchant: {
          name: merchant.display_name,
          location: merchant.location,
        },
        reputation: {
          tier: tier.name,
          tier_emoji: tier.emoji,
          tier_description: tier.description,
          trades_completed: tradesCompleted,
          completion_rate: completionRate,
          completion_percent: `${(completionRate * 100).toFixed(1)}%`,
          avg_time_minutes: merchant.avg_time_minutes,
          total_volume_usdc: merchant.total_volume_usdc.toFixed(2),
          on_chain_since: merchant.verified_at,
          nft_soulbound: null, // Planned for future implementation
        },
        agent_signal: {
          trusted,
          recommendation,
          risk_level: trusted
            ? completionRate >= 0.95 ? "low" : "medium"
            : "high",
        },
        data_source: "MicoPay P2P trade history",
        queried_at: new Date().toISOString(),
      });
    }
  );

  /**
   * GET /api/v1/merchants
   * Public. Returns all verified merchants with reputation data.
   */
  fastify.get(
    "/api/v1/merchants",
    async (_request, reply) => {
      try {
        // La normalización de tipos vive ahora en reputation-source: pg
        // devuelve los NUMERIC como string aunque el tipo diga number, y eso
        // se resuelve en un sitio en vez de en cada consumidor.
        const merchants = await getReputationSource().listVerified();

        const merchantsWithTier = merchants.map((m) => {
          const tier = getTier(m.trades_completed, m.completion_rate);
          return {
            ...m,
            tier: tier.name,
            completion_percent: `${(m.completion_rate * 100).toFixed(1)}%`,
          };
        });

        return reply.status(200).send(merchantsWithTier);
      } catch (err) {
        return reply.status(500).send({
          error: "Failed to fetch merchants",
          details: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );
}
