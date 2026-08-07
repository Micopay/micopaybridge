import type { FastifyRequest, FastifyReply, FastifyInstance } from "fastify";
import { Networks, Transaction, Keypair, Horizon } from "@stellar/stellar-sdk";
import { createWalletClient, createPublicClient, http, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  isPaymentUsed,
  markPaymentUsed,
  initX402Tables,
  cleanupExpiredPayments,
  reservePaymentKey,
  releaseReservedPayment,
} from "../db/x402.js";

let x402Initialized = false;

// SEC-A2: this was declared `false` and never assigned, so the durable
// Postgres replay store was dead code — every deploy silently used the
// in-memory Set, which a restart wipes clean (replay window reopens).
let useDatabase = false;

async function ensureX402Initialized() {
  if (x402Initialized) return;
  try {
    await initX402Tables();
    await cleanupExpiredPayments();
    x402Initialized = true;
    useDatabase = true;
  } catch (error) {
    console.warn('x402 DB init failed (will use in-memory fallback):', error);
    useDatabase = false;
  }
}

function getPlatformAddress(): string {
  const secret = process.env.PLATFORM_SECRET_KEY;
  if (secret) {
    try { return Keypair.fromSecret(secret).publicKey(); } catch {}
  }
  return process.env.PLATFORM_STELLAR_ADDRESS ?? "GDKKW2WSMQWZ63PIZBKDDBAAOBG5FP3TUHRYQ4U5RBKTFNESL5K5BJJK";
}

const PLATFORM_ADDRESS = getPlatformAddress();

const USDC_ASSET_CODE = "USDC";
// SEC-A1: without pinning the issuer, `op.asset.code === "USDC"` accepts an
// asset with that code minted by ANY account — a free, worthless lookalike.
const USDC_ISSUER = process.env.USDC_ISSUER ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const STELLAR_NETWORK = process.env.STELLAR_NETWORK ?? "TESTNET";
const NETWORK_PASSPHRASE =
  STELLAR_NETWORK === "MAINNET" ? Networks.PUBLIC : Networks.TESTNET;
const HORIZON_URL =
  STELLAR_NETWORK === "MAINNET" ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org";

// ── Base (BASE_IMPLEMENTATION_PLAN_2026-07.md, WP2) ─────────────────────────
const X402_ACCEPT_CHAINS = (process.env.X402_ACCEPT_CHAINS ?? "stellar")
  .split(",")
  .map((c) => c.trim().toLowerCase())
  .filter(Boolean);
const BASE_RPC_URL = process.env.BASE_RPC_URL ?? "https://sepolia.base.org";
const BASE_CHAIN_ID = parseInt(process.env.BASE_CHAIN_ID ?? "84532", 10);
const BASE_NETWORK_NAME = "base-sepolia";
const BASE_USDC_ADDRESS = (process.env.BASE_USDC_ADDRESS ??
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as `0x${string}`;
// EIP-712 domain for BASE_USDC_ADDRESS. Circle's OFFICIAL mainnet USDC
// contracts use name()="USD Coin", but this specific default testnet
// address (0x036CbD5...) does NOT — confirmed by calling name()/version()
// directly against Base Sepolia: name()="USDC", version()="2". Guessing
// "USD Coin" here produced a live "FiatTokenV2: invalid signature" revert
// during WP4 smoke testing even though our own off-chain verifyTypedData
// check passed (it was internally consistent with the agent's signer, but
// neither matched the contract's real domain separator). If you point
// BASE_USDC_ADDRESS at a different deployment, re-verify with:
//   cast call <address> "name()(string)" --rpc-url $BASE_RPC_URL
//   cast call <address> "version()(string)" --rpc-url $BASE_RPC_URL
const BASE_USDC_DOMAIN_NAME = process.env.BASE_USDC_NAME ?? "USDC";
const BASE_USDC_DOMAIN_VERSION = process.env.BASE_USDC_VERSION ?? "2";
const PLATFORM_BASE_ADDRESS = (process.env.PLATFORM_BASE_ADDRESS ?? "") as `0x${string}` | "";
const X402_FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? "";
const RELAYER_EVM_PRIVATE_KEY = process.env.RELAYER_EVM_PRIVATE_KEY ?? "";

const baseChain = {
  id: BASE_CHAIN_ID,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [BASE_RPC_URL] } },
} as const;

const USDC_TRANSFER_WITH_AUTH_ABI = [
  {
    name: "transferWithAuthorization",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

// USDC has 6 decimals — convert a decimal amount string ("0.001") to base
// units without floating point (REV-4: never parseFloat an on-chain amount).
function usdcToBaseUnits(decimalAmount: string): bigint {
  const [whole, frac = ""] = decimalAmount.split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  return BigInt(whole || "0") * 1_000_000n + BigInt(fracPadded || "0");
}

interface BaseX402Payload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: `0x${string}`;
    authorization: {
      from: `0x${string}`;
      to: `0x${string}`;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: `0x${string}`;
    };
  };
}

// Disambiguates the X-PAYMENT header content: Stellar's is base64(binary
// XDR), Base's is base64(JSON). A valid Stellar XDR essentially never
// base64-decodes to valid JSON with these specific fields, so attempting to
// parse it as the Base envelope first, and falling through on failure, is a
// safe and simple dispatch — it never touches the existing Stellar XDR path.
function tryParseBaseX402Payload(raw: string): BaseX402Payload | null {
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    if (
      parsed &&
      parsed.scheme === "exact" &&
      parsed.payload &&
      typeof parsed.payload.signature === "string" &&
      parsed.payload.authorization &&
      typeof parsed.payload.authorization.from === "string"
    ) {
      return parsed as BaseX402Payload;
    }
    return null;
  } catch {
    return null;
  }
}

export interface X402Config {
  /** Minimum amount in USDC (e.g. "0.001") */
  amount: string;
  /** Service name for the challenge */
  service: string;
}

/**
 * Factory: returns a Fastify preHandler that enforces x402 payment.
 *
 * Usage:
 *   fastify.get('/endpoint', { preHandler: requirePayment({ amount: '0.001', service: 'swap_search' }) }, handler)
 */
export function requirePayment(config: X402Config) {
  return async function x402PreHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const paymentHeader = request.headers["x-payment"] as string | undefined;

    if (!paymentHeader) {
      // No payment — return 402 challenge
      reply.status(402).send(build402Body(config));
      return;
    }

    // Verify the payment
    try {
      const payer = await verifyPayment(paymentHeader, config.amount, config.service);
      // Attach payer address to request for use in handlers
      (request as FastifyRequest & { payerAddress: string }).payerAddress = payer;
    } catch (err) {
      reply.status(402).send({
        status: 402,
        error: "Payment Invalid",
        message: err instanceof Error ? err.message : "Payment verification failed",
      });
      return;
    }
  };
}

// Canonical x402 challenge body: top-level `x402Version` + `accepts: []`
// (WP2 step 1) — not nested inside `challenge`, so existing x402 client
// packages that parse the standard shape work against MicoPay directly.
// `challenge` is kept as a sibling field for MicoPay's own Stellar clients
// that already read it (additive, doesn't break them).
function build402Body(config: X402Config) {
  const accepts: Record<string, unknown>[] = [];

  if (X402_ACCEPT_CHAINS.includes("stellar")) {
    accepts.push({
      scheme: "stellar-usdc",
      network: STELLAR_NETWORK.toLowerCase(),
      maxAmountRequired: config.amount,
      resource: config.service,
      description: `MicoPay ${config.service}`,
      payTo: PLATFORM_ADDRESS,
      asset: USDC_ISSUER,
      maxTimeoutSeconds: 300,
    });
  }

  if (X402_ACCEPT_CHAINS.includes("base") && PLATFORM_BASE_ADDRESS) {
    accepts.push({
      scheme: "exact",
      network: BASE_NETWORK_NAME,
      maxAmountRequired: usdcToBaseUnits(config.amount).toString(),
      resource: config.service,
      description: `MicoPay ${config.service}`,
      payTo: PLATFORM_BASE_ADDRESS,
      asset: BASE_USDC_ADDRESS,
      maxTimeoutSeconds: 300,
    });
  }

  return {
    x402Version: 1,
    accepts,
    status: 402,
    error: "Payment Required",
    challenge: {
      scheme: "stellar-usdc",
      amount_usdc: config.amount,
      pay_to: PLATFORM_ADDRESS,
      memo: `micopay:${config.service}`,
      expires_at: Math.floor(Date.now() / 1000) + 300, // 5 min
      service: config.service,
      network: STELLAR_NETWORK.toLowerCase(),
      instructions:
        "Send a Stellar USDC payment to pay_to with the specified memo. Include the signed XDR in X-PAYMENT header.",
    },
  };
}

/**
 * In-memory fallback for replay protection when DB is unavailable.
 */
const usedTxHashes = new Set<string>();

function reserveInMemory(key: string): boolean {
  if (usedTxHashes.has(key)) return false;
  usedTxHashes.add(key);
  return true;
}

function releaseInMemory(key: string): void {
  usedTxHashes.delete(key);
}

const horizonServer = new Horizon.Server(HORIZON_URL);

/**
 * Verify a payment submitted as signed XDR in the X-PAYMENT header.
 *
 * Returns the payer's Stellar address if valid.
 *
 * Checks:
 * - The XDR parses as a valid Stellar transaction
 * - The transaction has at least one payment operation of the pinned USDC
 *   asset (code + issuer) to PLATFORM_ADDRESS, meeting the minimum amount
 * - The transaction hash has not been seen before (replay protection)
 * - SEC-C1: the transaction is actually SUBMITTED to Horizon and confirmed —
 *   previously this function only parsed the XDR's *structure*; it never
 *   checked the signature was valid or that the payment was ever liquidated
 *   on-chain, so a well-formed but unsigned (or never-broadcast) XDR passed.
 *   Submitting server-side is also how we get real signature verification —
 *   Horizon rejects a badly- or un-signed envelope.
 */
async function verifyPayment(xdrBase64: string, minAmountUsdc: string, service: string): Promise<string> {
  await ensureX402Initialized();

  if (xdrBase64.startsWith("mock:")) {
    // SEC-C2: the mock bypass must never be reachable outside dev/test — gate
    // it explicitly instead of accepting "mock:" unconditionally (which meant
    // free credentials in any environment, including production). Reuses
    // X402_MOCK_MODE, which index.ts already refuses to start with in
    // production — that startup guard was previously disconnected from this
    // check, so it couldn't actually stop anything.
    if (!(process.env.X402_MOCK_MODE === "true" && process.env.NODE_ENV !== "production")) {
      throw new Error("Mock payments are disabled (set X402_MOCK_MODE=true outside production)");
    }
    return xdrBase64.replace("mock:", "").split(":")[0] ?? "GTEST_PAYER";
  }

  const basePayload = tryParseBaseX402Payload(xdrBase64);
  if (basePayload) {
    return verifyBasePayment(basePayload, minAmountUsdc, service);
  }

  let tx: Transaction;
  try {
    tx = new Transaction(xdrBase64, NETWORK_PASSPHRASE);
  } catch (err) {
    throw new Error(`Invalid payment XDR: ${err}`);
  }

  const payer = tx.source;
  const txHash = Buffer.from(tx.hash()).toString("hex");

  const alreadyUsed = useDatabase ? await isPaymentUsed(txHash) : usedTxHashes.has(txHash);
  if (alreadyUsed) {
    throw new Error(`Payment already used: ${txHash.slice(0, 16)}...`);
  }

  // SEC-A1: pin the issuer too — `code === "USDC"` alone accepts a worthless
  // lookalike asset minted by any account.
  let foundPayment = false;
  for (const op of tx.operations) {
    if (
      op.type === "payment" &&
      op.destination === PLATFORM_ADDRESS &&
      op.asset.code === USDC_ASSET_CODE &&
      "issuer" in op.asset &&
      op.asset.issuer === USDC_ISSUER
    ) {
      const amount = parseFloat(op.amount);
      const minAmount = parseFloat(minAmountUsdc);
      if (amount >= minAmount) {
        foundPayment = true;
        break;
      }
    }
  }

  if (!foundPayment) {
    throw new Error(
      `No valid USDC payment of ≥ ${minAmountUsdc} found to ${PLATFORM_ADDRESS}`
    );
  }

  // Submit server-side and require confirmation. If the client already
  // broadcast this exact envelope themselves, Horizon returns tx_bad_seq (or
  // similar) on resubmission — in that case fall back to checking whether a
  // transaction with this hash already succeeded, rather than rejecting a
  // legitimately-paid request.
  try {
    await horizonServer.submitTransaction(tx);
  } catch (err) {
    const alreadySettled = await checkTransactionSucceeded(txHash);
    if (!alreadySettled) {
      const detail = (err as { response?: { data?: unknown } })?.response?.data ?? err;
      throw new Error(`Payment submission failed: ${JSON.stringify(detail)}`);
    }
  }

  if (useDatabase) {
    await markPaymentUsed(txHash, payer, minAmountUsdc, service);
  } else {
    usedTxHashes.add(txHash);
  }

  return payer;
}

/** Checks whether a transaction with this hash already succeeded on-chain. */
async function checkTransactionSucceeded(txHash: string): Promise<boolean> {
  try {
    const record = await horizonServer.transactions().transaction(txHash).call();
    return record.successful === true;
  } catch {
    return false;
  }
}

/**
 * Verify + settle a Base x402 payment (EIP-3009 transferWithAuthorization).
 * Returns the payer's 0x address.
 */
async function verifyBasePayment(
  payload: BaseX402Payload,
  minAmountUsdc: string,
  service: string
): Promise<string> {
  if (!PLATFORM_BASE_ADDRESS) {
    throw new Error("Base payments are not configured (PLATFORM_BASE_ADDRESS unset)");
  }
  if (payload.network !== BASE_NETWORK_NAME) {
    throw new Error(`Unexpected network: ${payload.network} (expected ${BASE_NETWORK_NAME})`);
  }

  const auth = payload.payload.authorization;
  const { from, to, value, validAfter, validBefore, nonce } = auth;

  // REV-4: the signature is verified against a domain WE build — chainId and
  // verifyingContract come from our own config, never from the client's
  // payload. This is what actually pins "this authorization only spends
  // THIS USDC contract on THIS chain" (same spirit as SEC-A1 pinning the
  // Stellar USDC issuer instead of trusting the asset code alone).
  const signatureValid = await verifyTypedData({
    address: from,
    domain: {
      name: BASE_USDC_DOMAIN_NAME,
      version: BASE_USDC_DOMAIN_VERSION,
      chainId: BASE_CHAIN_ID,
      verifyingContract: BASE_USDC_ADDRESS,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from,
      to,
      value: BigInt(value),
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce,
    },
    signature: payload.payload.signature,
  });
  if (!signatureValid) {
    throw new Error("Invalid EIP-3009 signature");
  }

  if (to.toLowerCase() !== PLATFORM_BASE_ADDRESS.toLowerCase()) {
    throw new Error(`Payment destination mismatch: expected ${PLATFORM_BASE_ADDRESS}`);
  }

  // REV-4: BigInt comparison in base units — never parseFloat an amount
  // that decides whether money moved (USDC has 6 decimals, not the 7 XLM
  // has, and floating point has no place near a payment amount either way).
  const requiredBaseUnits = usdcToBaseUnits(minAmountUsdc);
  if (BigInt(value) < requiredBaseUnits) {
    throw new Error(`Underpayment: ${value} < ${requiredBaseUnits} base units`);
  }

  // REV-4: EIP-3009 has both bounds, not just an expiry.
  const nowSec = Math.floor(Date.now() / 1000);
  if (Number(validAfter) > nowSec) {
    throw new Error("Authorization not yet valid (validAfter is in the future)");
  }
  if (Number(validBefore) <= nowSec) {
    throw new Error("Authorization expired (validBefore has passed)");
  }

  // REV-2: the key is base:<from>:<nonce>, not just the nonce — on-chain
  // USDC only guarantees uniqueness of the (authorizer, nonce) PAIR; two
  // different payers may legitimately reuse the same nonce value.
  const replayKey = `base:${from.toLowerCase()}:${nonce.toLowerCase()}`;

  // REV-3: claim the key BEFORE settling, not after — otherwise two
  // concurrent requests carrying the same X-PAYMENT both pass verification
  // and both settle (the old order was verify -> settle -> mark-used, which
  // leaves a window open for the whole settlement duration).
  const reserved = useDatabase
    ? await reservePaymentKey(replayKey, from, minAmountUsdc, service)
    : reserveInMemory(replayKey);
  if (!reserved) {
    throw new Error(`Payment already used or in flight: ${replayKey.slice(0, 24)}...`);
  }

  try {
    await settleBasePayment(payload);
  } catch (err) {
    // Our own infra failure must not burn the agent's payment — release the
    // claim so the same authorization can be retried.
    if (useDatabase) await releaseReservedPayment(replayKey);
    else releaseInMemory(replayKey);
    throw err;
  }

  return from;
}

/**
 * Settle a verified Base payment. Facilitator is the primary path (no hot
 * relayer key needed in the happy path) — we've already done the
 * security-relevant verification above, so the facilitator is trusted only
 * to broadcast/confirm, not to re-decide validity. Self-submit via the
 * relayer key is the fallback when no facilitator is configured.
 */
async function settleBasePayment(payload: BaseX402Payload): Promise<void> {
  if (X402_FACILITATOR_URL) {
    const res = await fetch(`${X402_FACILITATOR_URL.replace(/\/$/, "")}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: payload.x402Version,
        paymentPayload: payload,
        paymentRequirements: {
          scheme: "exact",
          network: BASE_NETWORK_NAME,
          payTo: PLATFORM_BASE_ADDRESS,
          asset: BASE_USDC_ADDRESS,
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Facilitator settle failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json().catch(() => ({}))) as { success?: boolean };
    if (body.success === false) {
      throw new Error("Facilitator reported settlement failure");
    }
    return;
  }

  if (!RELAYER_EVM_PRIVATE_KEY) {
    throw new Error(
      "Cannot settle Base payment: neither X402_FACILITATOR_URL nor RELAYER_EVM_PRIVATE_KEY is configured"
    );
  }

  const account = privateKeyToAccount(RELAYER_EVM_PRIVATE_KEY as `0x${string}`);
  const walletClient = createWalletClient({ account, chain: baseChain, transport: http(BASE_RPC_URL) });
  const publicClient = createPublicClient({ chain: baseChain, transport: http(BASE_RPC_URL) });

  const auth = payload.payload.authorization;
  const hash = await walletClient.writeContract({
    address: BASE_USDC_ADDRESS,
    abi: USDC_TRANSFER_WITH_AUTH_ABI,
    functionName: "transferWithAuthorization",
    args: [
      auth.from,
      auth.to,
      BigInt(auth.value),
      BigInt(auth.validAfter),
      BigInt(auth.validBefore),
      auth.nonce,
      payload.payload.signature,
    ],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`transferWithAuthorization reverted: ${hash}`);
  }
}

/**
 * Plugin that adds x402 utilities to Fastify instance.
 * Tracks payment totals for the Fund Micopay widget.
 */
export async function x402Plugin(fastify: FastifyInstance): Promise<void> {
  fastify.decorate("requirePayment", requirePayment);
}

declare module "fastify" {
  interface FastifyInstance {
    requirePayment: typeof requirePayment;
  }
  interface FastifyRequest {
    payerAddress?: string;
  }
}
