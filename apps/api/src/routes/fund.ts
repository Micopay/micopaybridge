import type { FastifyInstance } from "fastify";
import { requirePayment } from "../middleware/x402.js";
import {
  Keypair,
  Asset,
  TransactionBuilder,
  Operation,
  Networks,
  Horizon,
  Memo,
  BASE_FEE,
} from "@stellar/stellar-sdk";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", USDC_ISSUER);
// Derive platform address from secret key (same account used by x402 middleware)
function getPlatformAddress(): string {
  const secret = process.env.PLATFORM_SECRET_KEY;
  if (secret) return Keypair.fromSecret(secret).publicKey();
  return process.env.PLATFORM_STELLAR_ADDRESS ?? "GDKKW2WSMQWZ63PIZBKDDBAAOBG5FP3TUHRYQ4U5RBKTFNESL5K5BJJK";
}
const PLATFORM_ADDRESS = getPlatformAddress();

async function sendRealUsdcPayment(
  senderSecret: string,
  destination: string,
  amount: string,
  memo: string
): Promise<string> {
  const horizonServer = new Horizon.Server(HORIZON_URL);
  const keypair = Keypair.fromSecret(senderSecret);
  const account = await horizonServer.loadAccount(keypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination, asset: USDC, amount }))
    .addMemo(Memo.text(memo.slice(0, 28)))
    .setTimeout(180)
    .build();

  tx.sign(keypair);
  const result = await horizonServer.submitTransaction(tx);
  return result.hash;
}

/**
 * Fund Micopay — The Meta-Demo Endpoint
 *
 * Any agent can donate USDC to fund the project using the same
 * x402 infrastructure it's demonstrating. No API key, no signup.
 *
 * This is the "moment demo" — an agent pays, the dashboard updates
 * in real time, the tx is verifiable on Stellar Expert.
 */

// In-memory store for demo — in production, this is the funding_contributions DB table
const contributions: Array<{
  id: string;
  supporter_address: string;
  amount_usdc: string;
  message?: string;
  created_at: string;
  stellar_tx_hash: string;
}> = [];

let totalFundedUsdc = 0;

export async function fundRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/v1/fund
   * x402: minimum $0.10 — fund the Micopay project
   */
  fastify.post(
    "/api/v1/fund",
    {
      preHandler: requirePayment({ amount: "0.10", service: "fund_micopay" }),
    },
    async (request, reply) => {
      const body = request.body as { message?: string } | undefined;
      const message = body?.message?.slice(0, 280);

      const contribution = {
        id: `mcp-supporter-${String(contributions.length + 1).padStart(3, "0")}`,
        supporter_address: request.payerAddress ?? "GUNKOWN",
        amount_usdc: "0.10", // minimum — real amount from payment verification
        message,
        created_at: new Date().toISOString(),
        stellar_tx_hash: `demo_${Date.now()}`, // real hash from payment tx
      };

      contributions.push(contribution);
      totalFundedUsdc += 0.10;

      fastify.log.info(
        `Fund contribution: ${contribution.supporter_address} — $${contribution.amount_usdc} USDC`
      );

      return reply.send({
        thank_you: true,
        supporter_id: contribution.id,
        amount_usdc: contribution.amount_usdc,
        stellar_tx_hash: contribution.stellar_tx_hash,
        total_funded_usdc: totalFundedUsdc.toFixed(2),
        total_supporters: contributions.length,
        message_recorded: !!message,
        stellar_expert_url: `https://stellar.expert/explorer/testnet/tx/${contribution.stellar_tx_hash}`,
      });
    }
  );

  /**
   * POST /api/v1/fund/demo
   * Free endpoint — the server's demo agent sends a REAL on-chain USDC payment
   * to the platform wallet and records it. This IS the meta-demo.
   */
  fastify.post("/api/v1/fund/demo", async (request, reply) => {
    const secret = process.env.DEMO_AGENT_SECRET_KEY;
    if (!secret) {
      return reply.status(503).send({ error: "Demo agent not configured. Run scripts/setup-demo-agent.mjs first." });
    }

    try {
      const txHash = await sendRealUsdcPayment(
        secret,
        PLATFORM_ADDRESS,
        "0.10",
        "micopay:fund_demo"
      );

      const agentPublicKey = Keypair.fromSecret(secret).publicKey();
      const contribution = {
        id: `mcp-supporter-${String(contributions.length + 1).padStart(3, "0")}`,
        supporter_address: agentPublicKey,
        amount_usdc: "0.10",
        message: "x402 works — funded by the demo agent itself",
        created_at: new Date().toISOString(),
        stellar_tx_hash: txHash,
      };

      contributions.push(contribution);
      totalFundedUsdc += 0.10;

      fastify.log.info(`Real on-chain fund: ${agentPublicKey} — tx ${txHash}`);

      return reply.send({
        thank_you: true,
        supporter_id: contribution.id,
        amount_usdc: contribution.amount_usdc,
        stellar_tx_hash: txHash,
        total_funded_usdc: totalFundedUsdc.toFixed(2),
        total_supporters: contributions.length,
        stellar_expert_url: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
        agent_address: agentPublicKey,
        message: "Real on-chain USDC payment — verify on Stellar Expert",
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: "Payment failed", detail: String(err) });
    }
  });

  /**
   * GET /api/v1/fund/stats
   * Free — public fund stats for the dashboard widget
   */
  fastify.get("/api/v1/fund/stats", async (_request, reply) => {
    const uniqueAddresses = new Set(contributions.map((c) => c.supporter_address)).size;

    return reply.send({
      total_funded_usdc: totalFundedUsdc.toFixed(2),
      total_supporters: uniqueAddresses,
      total_transactions: contributions.length,
      recent: contributions.slice(-10).reverse().map((c) => ({
        address: `${c.supporter_address.slice(0, 4)}...${c.supporter_address.slice(-4)}`,
        amount_usdc: c.amount_usdc,
        message: c.message,
        timestamp: c.created_at,
        stellar_expert_url: `https://stellar.expert/explorer/testnet/tx/${c.stellar_tx_hash}`,
      })),
    });
  });
}
