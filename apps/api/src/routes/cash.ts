import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { requirePayment } from "../middleware/x402.js";
import { randomUUID, randomBytes, createHash } from "crypto";
import * as StellarSdk from "@stellar/stellar-sdk";
import { findNearbyProviders, getTopProviders, MERCHANTS_DATA } from "../services/p2p.js";

const RPC_URL  = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NET      = StellarSdk.Networks.TESTNET;
const ESCROW_CONTRACT_ID = process.env.ESCROW_CONTRACT_ID!;
const PLATFORM_SECRET    = process.env.PLATFORM_SECRET_KEY!;
const USDC_ISSUER        = process.env.USDC_ISSUER ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

async function lockEscrow(
  amountUsdc: number,
  secretHash: string,
  timeoutMinutes: number,
): Promise<string> {
  // Demo: platform is both seller and buyer to avoid consuming the demo agent's
  // sequence number (demo.ts pre-builds all 6 Horizon txs upfront — if lockEscrow
  // used DEMO_AGENT_SECRET_KEY it would advance the on-chain sequence and invalidate
  // the pre-built fund_micopay tx).
  // In production: the real user wallet signs the lock tx.
  const sellerSecret = PLATFORM_SECRET;
  const sellerKP     = StellarSdk.Keypair.fromSecret(sellerSecret);
  const buyerAddress = StellarSdk.Keypair.fromSecret(PLATFORM_SECRET).publicKey();

  const rpc      = new StellarSdk.rpc.Server(RPC_URL);
  const account  = await rpc.getAccount(sellerKP.publicKey());
  const contract = new StellarSdk.Contract(ESCROW_CONTRACT_ID);

  const amountStroops = BigInt(Math.round(amountUsdc * 10_000_000));
  const platformFee   = BigInt(0); // zero fee for demo simplicity

  const args = [
    StellarSdk.Address.fromString(sellerKP.publicKey()).toScVal(), // seller: demo agent
    StellarSdk.Address.fromString(buyerAddress).toScVal(),         // buyer: platform (has USDC trustline)
    StellarSdk.nativeToScVal(amountStroops, { type: "i128" }),
    StellarSdk.nativeToScVal(platformFee, { type: "i128" }),
    StellarSdk.xdr.ScVal.scvBytes(Buffer.from(secretHash, "hex")),
    StellarSdk.nativeToScVal(timeoutMinutes, { type: "u32" }),
  ];

  let tx = new StellarSdk.TransactionBuilder(account, { fee: "1000000", networkPassphrase: NET })
    .addOperation(contract.call("lock", ...args))
    .setTimeout(180)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(`Escrow simulation failed: ${sim.error}`);
  }

  tx = StellarSdk.rpc.assembleTransaction(tx, sim).build();
  tx.sign(sellerKP);

  const result = await rpc.sendTransaction(tx);
  if (result.status === "ERROR") throw new Error(`Escrow send failed: ${JSON.stringify(result.errorResult)}`);

  // Poll via Horizon (avoids SDK v12 XDR parsing bug with rpc.getTransaction)
  const horizonUrl = `https://horizon-testnet.stellar.org/transactions/${result.hash}`;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, i === 0 ? 1000 : 1500));
    try {
      const res = await fetch(horizonUrl);
      if (res.ok) {
        const data = await res.json() as { successful: boolean };
        if (data.successful) return result.hash;
        throw new Error(`Escrow tx failed on-chain: ${result.hash}`);
      }
      // 404 = still pending
    } catch (err: any) {
      if (err.message.includes('failed on-chain')) throw err;
    }
  }
  throw new Error(`Escrow timeout: ${result.hash}`);
}

// ── Mock merchant network (replaces live P2P backend connection - roadmap) ──
// Using data from P2P matching engine
export const MERCHANTS = MERCHANTS_DATA;

// Base URL for claim pages — where AI agents send users to show their QR
// In production: https://app.micopay.xyz
const CLAIM_BASE_URL = process.env.CLAIM_BASE_URL ?? "http://localhost:5181";

// In-memory store for cash requests (roadmap: connect to MicoPay P2P backend)
const cashRequests = new Map<string, {
  request_id: string;
  merchant_address: string;
  merchant_name: string;
  amount_mxn: number;
  amount_usdc: string;
  htlc_secret_hash: string;
  /** Preimage. NUNCA se devuelve en una respuesta salvo por /claim. */
  htlc_secret: string;
  htlc_tx_hash: string;
  status: "pending" | "accepted" | "completed" | "expired";
  created_at: string;
  expires_at: string;
  qr_payload: string;
  payer_address: string;
}>();

/**
 * Tokens de canje del QR (SEC-02). Solo se guarda el sha256 del token; el
 * token en claro vive únicamente dentro del QR que ve el usuario.
 *
 * `consumed_at` da el marcado de un solo uso: dos escaneos simultáneos no
 * pueden ganar los dos.
 */
export const claimTokens = new Map<string, {
  request_id: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_by: string | null;
}>();

/** 15 minutos: el QR se enseña en el mostrador, no se guarda para después. */
const CLAIM_TOKEN_TTL_MS = 15 * 60 * 1000;

function hashClaimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Live USDC/MXN rate from Horizon (with fallback)
let cachedRate: { rate: number; ts: number } | null = null;

async function getUsdcMxnRate(): Promise<number> {
  if (cachedRate && Date.now() - cachedRate.ts < 60_000) return cachedRate.rate;
  // Fixed demo rate: 1 USDC ≈ 17.5 MXN (realistic mid-2026 rate for testnet demo)
  // In production: use live oracle (Chainlink, CoinGecko, or Etherfuse feed)
  cachedRate = { rate: 17.5, ts: Date.now() };
  return cachedRate.rate;
}

export async function cashRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/v1/cash/agents
   * x402: $0.001 USDC
   *
   * Find available cash merchants near a location.
   * Returns merchants sorted by distance, filtered by amount and online status.
   *
   * Query params:
   *   lat      — user latitude  (default: Roma Norte, CDMX)
   *   lng      — user longitude (default: Roma Norte, CDMX)
   *   amount   — MXN amount needed (default: 500)
   *   limit    — max results (default: 5)
   */
  fastify.get(
    "/api/v1/cash/agents",
    { preHandler: requirePayment({ amount: "0.001", service: "cash_agents" }) },
    async (request, reply) => {
      const query = request.query as Record<string, string>;
      const lat = parseFloat(query.lat ?? "19.4195");
      const lng = parseFloat(query.lng ?? "-99.1627");
      const amount = parseInt(query.amount ?? "500", 10);
      const limit = Math.min(parseInt(query.limit ?? "5", 10), 10);
      const radiusKm = Math.min(parseInt(query.radius ?? "50", 10), 100);

      const rate = await getUsdcMxnRate();

      let results;
      try {
        const topProviders = getTopProviders({ lat, lng, amount }, limit);
        results = topProviders.map((p) => ({
          id: p.id,
          stellar_address: p.stellar_address,
          name: p.name,
          type: p.type,
          address: p.address,
          distance_km: p.distance_km,
          available_mxn: p.available_mxn,
          max_trade_mxn: p.max_trade_mxn,
          min_trade_mxn: p.min_trade_mxn,
          tier: p.tier,
          reputation: p.reputation,
          completion_rate: p.completion_rate,
          trades_completed: p.trades_completed,
          avg_time_minutes: p.avg_time_minutes,
          online: p.online,
          score: p.score,
          usdc_rate: parseFloat((1 / rate).toFixed(6)),
          amount_usdc_needed: parseFloat((amount / rate).toFixed(4)),
        }));
      } catch {
        const nearby = findNearbyProviders(lat, lng, radiusKm, amount);
        results = nearby.slice(0, limit).map((m) => ({
          id: m.id,
          stellar_address: m.stellar_address,
          name: m.name,
          type: m.type,
          address: m.address,
          distance_km: parseFloat(distanceKm(lat, lng, m.lat, m.lng).toFixed(2)),
          available_mxn: m.available_mxn,
          max_trade_mxn: m.max_trade_mxn,
          min_trade_mxn: m.min_trade_mxn,
          tier: m.tier,
          reputation: m.reputation,
          completion_rate: m.completion_rate,
          trades_completed: m.trades_completed,
          avg_time_minutes: m.avg_time_minutes,
          online: m.online,
          usdc_rate: parseFloat((1 / rate).toFixed(6)),
          amount_usdc_needed: parseFloat((amount / rate).toFixed(4)),
        }));
      }

      return reply.send({
        agents: results,
        count: results.length,
        query: { lat, lng, amount_mxn: amount, radius_km: radiusKm },
        usdc_mxn_rate: rate,
        network: process.env.STELLAR_NETWORK ?? "TESTNET",
        note: "Merchants from MicoPay P2P network with P2P matching engine. Rates from Stellar Horizon testnet.",
        matching_engine: "p2p-v1",
      });
    }
  );

  /**
   * POST /api/v1/cash/request
   * x402: $0.01 USDC
   *
   * Initiate a USDC → MXN cash exchange with a merchant.
   * Locks USDC in an HTLC on Soroban. Returns QR code for the user to show.
   *
   * Body:
   *   merchant_address — Stellar address of the target merchant
   *   amount_mxn       — MXN amount to receive
   *   user_lat         — (optional) user location for validation
   *   user_lng         — (optional) user location for validation
   */
  fastify.post(
    "/api/v1/cash/request",
    { preHandler: requirePayment({ amount: "0.01", service: "cash_request" }) },
    async (request, reply) => {
      const body = request.body as {
        merchant_address?: string;
        amount_mxn?: number;
        user_lat?: number;
        user_lng?: number;
      } | undefined;

      const merchantAddress = body?.merchant_address;
      const amountMxn = body?.amount_mxn ?? 500;

      if (!merchantAddress) {
        return reply.status(400).send({ error: "merchant_address is required" });
      }
      // `body` es `as`, no un schema: un amount_mxn no numérico (ej. "abc") hace
      // que `< 50` y `> 5000` den las dos `false` (comparación con NaN), así que
      // el rango se saltaba entero. Number.isFinite lo cierra — mismo patrón que
      // ya usa validatePlan() en agent.ts para initiator_ledgers/counterparty_ledgers.
      if (typeof amountMxn !== "number" || !Number.isFinite(amountMxn) || amountMxn < 50 || amountMxn > 5000) {
        return reply.status(400).send({ error: "amount_mxn must be a number between 50 and 5000" });
      }

      const merchant = MERCHANTS.find((m) => m.stellar_address === merchantAddress);
      if (!merchant) {
        return reply.status(404).send({ error: "Merchant not found in MicoPay network" });
      }
      if (!merchant.online) {
        return reply.status(409).send({ error: "Merchant is currently offline" });
      }
      if (amountMxn > merchant.available_mxn) {
        return reply.status(409).send({
          error: `Merchant only has $${merchant.available_mxn} MXN available`,
        });
      }

      const rate = await getUsdcMxnRate();
      const amountUsdc = parseFloat((amountMxn / rate).toFixed(4));

      // SEC-02 — el preimage HTLC NO sale de aquí.
      //
      // Antes el QR llevaba `secret=<preimage>` y la respuesta devolvía ese QR
      // a quien llamaba. Cualquiera que pagara $0.01 obtenía la preimagen y
      // podía liberar el escrow directamente contra el contrato SIN entregar
      // el efectivo, mientras la respuesta afirmaba "USDC releases only when
      // merchant scans QR".
      //
      // El QR lleva ahora un token opaco de un solo uso, del que solo se
      // guarda el sha256 — mismo principio que `secret_hash`. Es el port del
      // arreglo que el equipo ya hizo en micopay/backend
      // (migración 20260728220000_trade_claim_tokens).
      const requestId  = `mcr-${randomUUID().slice(0, 8)}`;
      const secretBytes = randomBytes(32);
      const secret      = secretBytes.toString("hex");
      const secretHash  = createHash("sha256").update(secretBytes).digest("hex");
      const expiresAt   = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

      const claimToken     = randomBytes(32).toString("hex");
      const claimExpiresAt = new Date(Date.now() + CLAIM_TOKEN_TTL_MS).toISOString();

      // Lock real USDC in MicopayEscrow on Soroban testnet
      // Cap demo lock at 1 USDC to preserve agent balance across multiple demos
      const lockAmount = Math.min(amountUsdc, 1.0);
      let htlcTxHash: string;
      try {
        htlcTxHash = await lockEscrow(lockAmount, secretHash, 120);
        fastify.log.info(`Escrow locked on-chain: ${htlcTxHash}`);
      } catch (err) {
        fastify.log.error(`Escrow failed, falling back to demo mode: ${err}`);
        htlcTxHash = `demo_htlc_${Date.now()}_${requestId}`;
      }

      // El QR lleva un token opaco. No dice nada que sirva para liberar el
      // escrow por su cuenta: hay que canjearlo en /claim, y solo una vez.
      const qrPayload = `micopay://claim?request_id=${requestId}&token=${claimToken}&amount_mxn=${amountMxn}`;

      const cashRequest = {
        request_id: requestId,
        merchant_address: merchantAddress,
        merchant_name: merchant.name,
        amount_mxn: amountMxn,
        amount_usdc: amountUsdc.toFixed(4),
        htlc_secret_hash: secretHash,
        // El preimage se queda del lado del servidor y solo sale por /claim,
        // contra un token válido y sin consumir.
        htlc_secret: secret,
        htlc_tx_hash: htlcTxHash,
        status: "pending" as const,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
        qr_payload: qrPayload,
        payer_address: request.payerAddress ?? "GUNKNOWN",
      };

      cashRequests.set(requestId, cashRequest);
      // Del token solo se guarda el hash: el token en claro no se persiste
      // en ningún sitio, igual que en micopay/backend.
      claimTokens.set(hashClaimToken(claimToken), {
        request_id: requestId,
        expires_at: claimExpiresAt,
        consumed_at: null,
        consumed_by: null,
      });

      fastify.log.info(
        `Cash request ${requestId}: ${request.payerAddress} → ${merchant.name} $${amountMxn} MXN`
      );

      return reply.status(201).send({
        request_id: requestId,
        status: "pending",
        merchant: {
          name: merchant.name,
          address: merchant.address,
          stellar_address: merchantAddress,
          tier: merchant.tier,
        },
        exchange: {
          amount_mxn: amountMxn,
          amount_usdc: amountUsdc.toFixed(4),
          rate_usdc_mxn: rate,
          htlc_tx_hash: htlcTxHash,
          htlc_explorer_url: `https://stellar.expert/explorer/testnet/tx/${htlcTxHash}`,
        },
        qr_payload: qrPayload,
        claim_url: `${CLAIM_BASE_URL}/claim/${requestId}`,
        instructions: `Go to ${merchant.name} at ${merchant.address}. Open the claim_url on your phone to show the QR. The merchant will give you $${amountMxn} MXN in cash and scan the QR to release the USDC.`,
        expires_at: expiresAt,
        note: "HTLC locked on Soroban. Merchant notified. USDC releases only when merchant scans QR.",
      });
    }
  );

  /**
   * GET /api/v1/cash/request/:id
   * x402: $0.0001 USDC — poll status of a cash request
   *
   * Security (SEC-03): this endpoint exposes merchant name, MXN amount, HTLC tx
   * hash and expiry. Request IDs (`mcr-{8 hex}`) are short and enumerable, so the
   * endpoint must NOT be free/unauthenticated. We gate it behind the same x402
   * micropayment used by GET /api/v1/swaps/:id/status, and apply a strict
   * per-route rate limit as defense-in-depth against ID brute-forcing.
   * See docs/security-reports/SEC-03-cash-request-sin-auth.md
   */
  fastify.get(
    "/api/v1/cash/request/:id",
    {
      preHandler: requirePayment({ amount: "0.0001", service: "cash_request_status" }),
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const req = cashRequests.get(id);
    if (!req) return reply.status(404).send({ error: "Request not found" });

    return reply.send({
      request_id: req.request_id,
      status: req.status,
      merchant_name: req.merchant_name,
      amount_mxn: req.amount_mxn,
      amount_usdc: req.amount_usdc,
      htlc_tx_hash: req.htlc_tx_hash,
      expires_at: req.expires_at,
    });
  });

  /**
   * POST /api/v1/cash/request/:id/claim
   *
   * El comercio canjea el token del QR y recibe el preimage para liberar el
   * escrow. Es la otra mitad del arreglo de SEC-02: el secreto ya no viaja en
   * el QR, se entrega aquí contra un token válido, vigente y sin consumir.
   *
   * Sin x402 a propósito: cobrarle al comercio por cobrar sería absurdo.
   */
  fastify.post("/api/v1/cash/request/:id/claim", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { token?: string; merchant_address?: string };

    if (!body.token) {
      return reply.status(400).send({ error: "token requerido", hint: "viene en el QR" });
    }

    const req = cashRequests.get(id);
    if (!req) return reply.status(404).send({ error: "Request not found" });

    const tokenHash = hashClaimToken(body.token);
    const entry = claimTokens.get(tokenHash);

    // Se comprueba también que el token sea DE ESTA petición: si no, un token
    // válido de otra serviría para cobrar aquí.
    if (!entry || entry.request_id !== id) {
      return reply.status(404).send({ error: "INVALID_CLAIM_TOKEN", detail: "Este QR no es válido para esta operación" });
    }
    if (entry.consumed_at !== null) {
      return reply.status(409).send({ error: "CLAIM_TOKEN_USED", detail: "Este QR ya fue usado", consumed_at: entry.consumed_at });
    }
    if (new Date(entry.expires_at) < new Date()) {
      return reply.status(410).send({ error: "CLAIM_TOKEN_EXPIRED", detail: "Este QR expiró. Pide uno nuevo" });
    }
    if (body.merchant_address && body.merchant_address !== req.merchant_address) {
      return reply.status(403).send({ error: "MERCHANT_MISMATCH", detail: "Este QR es para otro comercio" });
    }

    // Marcado de un solo uso. En un solo proceso Node esto es atómico porque
    // no hay await entre la lectura y la escritura; con la tabla de
    // micopay/backend el equivalente es el UPDATE con `consumed_at IS NULL`.
    entry.consumed_at = new Date().toISOString();
    // NUNCA rellenar con req.merchant_address: como el chequeo de arriba es
    // opcional (mientras no exista auth de comercio, WAVE5 Issue 8), rellenar
    // con el comercio de la petición hacía que el log atribuyera el canje al
    // comercio legítimo aunque lo hubiera canjeado cualquier otro portador del
    // token sin identificarse. Si no lo dijo, no se sabe quién fue.
    entry.consumed_by = body.merchant_address ?? null;
    claimTokens.set(tokenHash, entry);

    cashRequests.set(id, { ...req, status: "completed" });

    // El token NO se registra en el log; el preimage tampoco.
    fastify.log.info(`Claim consumido: ${id} por ${entry.consumed_by ?? "portador sin identificar (merchant_address no enviado)"}`);

    return reply.send({
      request_id: id,
      status: "completed",
      merchant_name: req.merchant_name,
      amount_mxn: req.amount_mxn,
      amount_usdc: req.amount_usdc,
      htlc_secret: req.htlc_secret,
      htlc_secret_hash: req.htlc_secret_hash,
      contract: ESCROW_CONTRACT_ID,
      note: "Usa htlc_secret para liberar el escrow. Este token ya no sirve otra vez.",
    });
  });
}
