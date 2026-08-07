import type { FastifyInstance } from "fastify";
import { requirePayment } from "../middleware/x402.js";
import { query } from "../db/schema.js";
// TODO(§M3 del plan de split) — FRONTERA ENTRE LOS DOS REPOS, SIN RESOLVER.
// Esta ruta sirve reputación a agentes detrás de x402, pero la calcula
// leyendo datos de comercios que después del split son del backend móvil
// (micopay/backend). Hoy esto es la opción (a): leer el mismo esquema. La
// recomendada es la (b): que el backend móvil exponga un endpoint interno
// de reputación y este repo lo consuma, con un contrato explícito y
// versionable. Mientras siga así, una migración del móvil puede romper a
// los agentes sin avisar.
import { getVerifiedMerchants } from "../db/merchants.js";

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

export async function reputationRoutes(fastify: FastifyInstance): Promise<void> {
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

      // Query merchant from database
      const merchantResult = await query(`
        SELECT m.display_name, m.latitude, m.longitude, m.address_text,
               m.trades_completed, m.completion_rate, m.avg_time_minutes,
               m.tier, m.total_volume_usdc, m.last_trade_at, m.verified_at,
               u.stellar_address
        FROM merchants m
        LEFT JOIN users u ON m.user_id = u.id
        WHERE m.verification_status = 'verified'
        ORDER BY m.verified_at DESC
        LIMIT 1
      `);

      // If no merchant found, return placeholder data
      if (!merchantResult.rows[0]) {
        return reply.status(404).send({
          error: "No verified merchant found",
          hint: "This Stellar address does not correspond to a verified merchant",
        });
      }

      const merchant = merchantResult.rows[0];
      const tradesCompleted = parseInt(merchant.trades_completed) || 0;
      const completionRate = parseFloat(merchant.completion_rate) || 0;
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
          location: merchant.address_text,
        },
        reputation: {
          tier: tier.name,
          tier_emoji: tier.emoji,
          tier_description: tier.description,
          trades_completed: tradesCompleted,
          completion_rate: completionRate,
          completion_percent: `${(completionRate * 100).toFixed(1)}%`,
          avg_time_minutes: merchant.avg_time_minutes,
          total_volume_usdc: parseFloat(merchant.total_volume_usdc).toFixed(2),
          on_chain_since: merchant.verified_at || merchant.created_at,
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
        const merchants = await getVerifiedMerchants();

        // Calculate tier for each merchant
        //
        // parseInt/parseFloat esperaban string, pero PublicMerchantRow declara
        // los dos campos como number (db/merchants.ts) — de ahí los tres TS2345.
        // Number() es el arreglo correcto en vez de castear: acepta las dos
        // formas. Importa porque en runtime no coinciden con el tipo:
        // trades_completed es INTEGER y pg lo devuelve como number, pero
        // completion_rate es DECIMAL(5,4) y pg devuelve los NUMERIC como
        // string para no perder precisión.
        const merchantsWithTier = merchants.map((m) => {
          const tier = getTier(
            Number(m.trades_completed) || 0,
            Number(m.completion_rate) || 0
          );
          return {
            ...m,
            tier: tier.name,
            completion_percent: `${(Number(m.completion_rate) * 100).toFixed(1)}%`,
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
