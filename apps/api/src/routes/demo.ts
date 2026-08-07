import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
import { config } from "../config.js";
import { DEMO_USER } from "../scripts/seed.js";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", USDC_ISSUER);
const EXPLORER = "https://stellar.expert/explorer/testnet/tx";
const DEMO_MERCHANT =
  "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKUJI5KOOJ9TXWNTBBS2JN";

function getPlatformAddress(): string {
  const secret = process.env.PLATFORM_SECRET_KEY;
  if (secret) {
    try {
      return Keypair.fromSecret(secret).publicKey();
    } catch {}
  }
  return "GDKKW2WSMQWZ63PIZBKDDBAAOBG5FP3TUHRYQ4U5RBKTFNESL5K5BJJK";
}

export async function demoRoutes(
  fastify: FastifyInstance & { jwt?: any },
): Promise<void> {
  /**
   * GET /api/v1/demo/status
   * Public endpoint — no auth required.
   * Returns { demo_mode: boolean } reflecting config.demoMode.
   */
  fastify.get("/api/v1/demo/status", async (_request, reply) => {
    return reply.send({ demo_mode: config.demoMode });
  });

  /**
   * POST /auth/demo-login
   * Issues a 24h JWT for the demo account when demoMode=true.
   * Returns 404 when demoMode=false (requirement 3.2, 9.2).
   */
  fastify.post("/auth/demo-login", async (_request, reply) => {
    if (!config.demoMode) {
      return reply.status(404).send();
    }

    if (!fastify.jwt) {
      return reply.status(503).send({ error: "JWT plugin not registered" });
    }

    const token = fastify.jwt.sign(
      { id: DEMO_USER.id, stellar_address: DEMO_USER.stellar_address },
      { expiresIn: "24h" },
    );

    return reply.send({
      token,
      user: {
        id: DEMO_USER.id,
        username: DEMO_USER.username,
        stellar_address: DEMO_USER.stellar_address,
      },
    });
  });

  /**
   * POST /api/v1/demo/run
   *
   * Full MicoPay demo — 5 real on-chain USDC payments:
   *   Step 1  bazaar_intent $0.005  USDC  — broadcast intent (Agent Social Layer)
   *   Step 2  cash_agents   $0.001  USDC  — find merchants near Roma Norte, CDMX
   *   Step 3  reputation    $0.0005 USDC  — verify Farmacia Guadalupe (tier Maestro)
   *   Step 4  cash_request  $0.010  USDC  — lock USDC, get QR for $500 MXN cash
   *   Step 5  fund_micopay  $0.100  USDC  — fund the protocol (meta-demo)
   *
   * Total: ~$0.1165 USDC. All tx hashes verifiable on stellar.expert.
   */
  fastify.post("/api/v1/demo/run", async (_request, reply) => {
    const secret = process.env.DEMO_AGENT_SECRET_KEY;
    if (!secret) {
      return reply.status(503).send({
        error:
          "Demo agent not configured. Run scripts/setup-demo-agent.mjs first.",
      });
    }

    const agentKP = Keypair.fromSecret(secret);
    const agentAddress = agentKP.publicKey();
    const platformAddr = getPlatformAddress();
    const horizon = new Horizon.Server(HORIZON_URL);
    const port = process.env.PORT ?? "3000";
    const baseUrl = `http://localhost:${port}`;

    const account = await horizon.loadAccount(agentAddress);

    function buildTx(amount: string, memo: string) {
      // TransactionBuilder.build() increments account.sequenceNumber internally —
      // do NOT call account.incrementSequenceNumber() manually here.
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({ destination: platformAddr, asset: USDC, amount }),
        )
        .addMemo(Memo.text(memo.slice(0, 28)))
        .setTimeout(180)
        .build();
      tx.sign(agentKP);
      return tx;
    }

    const tx0 = buildTx("0.0050000", "micopay:bazaar_broadcast");
    const txA = buildTx("0.0050000", "micopay:bazaar_accept");
    const tx1 = buildTx("0.0010000", "micopay:cash_agents");
    const tx2 = buildTx("0.0005000", "micopay:reputation");
    const tx3 = buildTx("0.0100000", "micopay:cash_request");
    const tx4 = buildTx("0.1000000", "micopay:fund_demo");

    const steps: any[] = [];

    try {
      // ── Step 0: Bazaar Broadcast ──────────────────────────────────────────────
      // Agent publishes cross-chain intent to the global social layer.
      // x402 payment prevents spam — only serious agents broadcast.
      const r0 = await horizon.submitTransaction(tx0);
      const s0Res = await fetch(`${baseUrl}/api/v1/bazaar/intent`, {
        method: "POST",
        headers: {
          "x-payment": tx0.toXDR(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          offered: { chain: "ethereum", symbol: "ETH", amount: "1.2" },
          wanted: { chain: "stellar", symbol: "USDC", amount: "28.57" },
        }),
      });
      const s0 = (await s0Res.json()) as any;
      steps.push({
        name: "bazaar_broadcast",
        description:
          "Agent broadcasts cross-chain intent: ETH → USDC. x402 payment prevents spam.",
        price_usdc: "0.005",
        tx_hash: r0.hash,
        stellar_expert_url: `${EXPLORER}/${r0.hash}`,
        result: s0,
      });

      // ── Step 0b: Bazaar Accept (Stellar Side Anchored On-Chain) ──────────────
      // Market maker picks up the intent. Agent accepts and the Stellar side
      // of the cross-chain swap is locked via MicopayEscrow on Soroban.
      // AtomicSwapHTLC (37 tests, built) resolves the ETH side in production.
      const intentId = s0?.id;
      if (intentId) {
        const rA = await horizon.submitTransaction(txA);
        const s0bRes = await fetch(`${baseUrl}/api/v1/bazaar/accept`, {
          method: "POST",
          headers: {
            "x-payment": txA.toXDR(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ intent_id: intentId, amount_usdc: 28.57 }),
        });
        const s0b = (await s0bRes.json()) as any;
        steps.push({
          name: "bazaar_accept",
          description:
            "Stellar side anchored on-chain. USDC locked as cross-chain collateral via MicopayEscrow.",
          price_usdc: "0.005",
          tx_hash: rA.hash,
          stellar_expert_url: `${EXPLORER}/${rA.hash}`,
          soroban_tx_hash: s0b?.handshake?.htlc_tx_hash,
          soroban_explorer_url: s0b?.handshake?.htlc_explorer_url,
          result: s0b,
        });
      }

      // ── Step 1: Find Cash Merchants ───────────────────────────────────────────
      // Agent (now holding USDC from the cross-chain swap) finds the nearest
      // trusted merchant to deliver MXN cash to the user.
      const r1 = await horizon.submitTransaction(tx1);
      const s1 = await fetch(
        `${baseUrl}/api/v1/cash/agents?lat=19.4195&lng=-99.1627&amount=500&limit=3`,
        { headers: { "x-payment": tx1.toXDR() } },
      );
      steps.push({
        name: "cash_agents",
        description:
          "Find cash merchants near Roma Norte, CDMX. Agent selects best option.",
        price_usdc: "0.001",
        tx_hash: r1.hash,
        stellar_expert_url: `${EXPLORER}/${r1.hash}`,
        result: await s1.json(),
      });

      // ── Step 2: Verify Merchant Reputation ───────────────────────────────────
      const r2 = await horizon.submitTransaction(tx2);
      const s2 = await fetch(`${baseUrl}/api/v1/reputation/${DEMO_MERCHANT}`, {
        headers: { "x-payment": tx2.toXDR() },
      });
      steps.push({
        name: "reputation",
        description:
          "Verify Farmacia Guadalupe on-chain reputation. NFT soulbound badge. Can't be faked.",
        price_usdc: "0.0005",
        tx_hash: r2.hash,
        stellar_expert_url: `${EXPLORER}/${r2.hash}`,
        result: await s2.json(),
      });

      // ── Step 3: Lock USDC → Physical Cash QR ─────────────────────────────────
      // Final USDC lock in MicopayEscrow on Soroban. Returns claim_url QR.
      // Merchant scans QR → USDC released. User gets $500 MXN cash.
      const r3 = await horizon.submitTransaction(tx3);
      const s3 = await fetch(`${baseUrl}/api/v1/cash/request`, {
        method: "POST",
        headers: {
          "x-payment": tx3.toXDR(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          merchant_address: DEMO_MERCHANT,
          amount_mxn: 500,
        }),
      });
      steps.push({
        name: "cash_request",
        description:
          "Lock USDC in MicopayEscrow on Soroban → QR code for $500 MXN at Farmacia Guadalupe.",
        price_usdc: "0.01",
        tx_hash: r3.hash,
        stellar_expert_url: `${EXPLORER}/${r3.hash}`,
        result: await s3.json(),
      });

      // ── Step 4: Fund MicoPay (Meta-Demo) ─────────────────────────────────────
      const r4 = await horizon.submitTransaction(tx4);
      steps.push({
        name: "fund_micopay",
        description:
          "Agent funds the protocol it just used. x402 is self-sustaining.",
        price_usdc: "0.10",
        tx_hash: r4.hash,
        stellar_expert_url: `${EXPLORER}/${r4.hash}`,
        result: { message: "x402 works — protocol funds itself" },
      });

      return reply.send({
        agent_address: agentAddress,
        platform_address: platformAddr,
        total_paid_usdc: "0.1215",
        user_received: "$500 MXN en efectivo físico",
        steps,
        framing:
          "Cross-chain intent coordinated via Bazaar. Stellar side anchored on Soroban. AtomicSwapHTLC (built + 37 tests) resolves the counterpart chain in production.",
        summary:
          "From cross-chain intent to physical cash in Mexico — trustless, no API keys, no bank.",
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({
        error: "Demo failed",
        detail: String(err),
        steps_completed: steps,
      });
    }
  });

  /**
   * POST /api/v1/demo/run-zk
   *
   * ZK credential demo — buy (public, x402) -> spend (anonymous, ZK proof) -> reuse rejected:
   *   Step 1  credential_buy $0.01 USDC — buy an anonymous access credential (real Stellar payment)
   *   Step 2  inference_spend           — spend a pre-generated, unspent credential's ZK proof
   *                                       (WP-D1 fixture) -> Claude responds, nullifier burned on Soroban
   *   Step 3  inference_reuse_rejected  — resubmit the SAME proof -> rejected (burn-once proven)
   *
   * Steps 2-3 deliberately spend the WP-D1 FIXTURE, not the credential bought in step 1 — ZK proof
   * generation (nargo/bb) is a manual, multi-minute offline step that can't happen live during a
   * recording. See docs/zk-agent-credentials/DEMO_RECORDING_PLAN_2026-07.md.
   *
   * Only runs the fixture through steps 2-3 ONCE successfully, ever — after that, step 2 itself
   * starts returning 409 (its nullifier is now burned), which still demonstrates the point but
   * isn't the intended "wow" order. Regenerate the fixture (WP-D1) for a fresh take.
   */
  fastify.post("/api/v1/demo/run-zk", async (_request, reply) => {
    const secret = process.env.DEMO_AGENT_SECRET_KEY;
    if (!secret) {
      return reply.status(503).send({
        error:
          "Demo agent not configured. Run scripts/setup-demo-agent.mjs first.",
      });
    }

    const fixturePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "demo",
      "zk_demo_proof.json",
    );
    let fixture: { circuit_id: string; proof: string; public_inputs: string[] };
    try {
      fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
    } catch {
      return reply.status(503).send({
        error:
          "ZK demo fixture missing — run WP-D1 (see DEMO_RECORDING_PLAN_2026-07.md) to generate apps/api/demo/zk_demo_proof.json.",
      });
    }

    const agentKP = Keypair.fromSecret(secret);
    const agentAddress = agentKP.publicKey();
    const platformAddr = getPlatformAddress();
    const horizon = new Horizon.Server(HORIZON_URL);
    const port = process.env.PORT ?? "3000";
    const baseUrl = `http://localhost:${port}`;

    const account = await horizon.loadAccount(agentAddress);

    function buildTx(amount: string, memo: string) {
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({ destination: platformAddr, asset: USDC, amount }),
        )
        .addMemo(Memo.text(memo.slice(0, 28)))
        .setTimeout(180)
        .build();
      tx.sign(agentKP);
      return tx;
    }

    const txBuy = buildTx("0.0100000", "micopay:credential_buy");
    const steps: any[] = [];

    try {
      // ── Step 1: Buy — public x402 payment, real Stellar tx ──────────────────
      const rBuy = await horizon.submitTransaction(txBuy);
      const buyRes = await fetch(`${baseUrl}/api/v1/credentials/buy`, {
        method: "POST",
        headers: {
          "x-payment": txBuy.toXDR(),
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      const buyBody = (await buyRes.json()) as any;
      steps.push({
        name: "credential_buy",
        description:
          "Agent buys an anonymous access credential. This payment is public — a payment has nothing to hide.",
        price_usdc: "0.01",
        tx_hash: rBuy.hash,
        stellar_expert_url: `${EXPLORER}/${rBuy.hash}`,
        result: buyBody,
      });

      // ── Step 2: Spend — anonymous ZK proof, real Soroban verify_unique call ─
      const spendRes = await fetch(`${baseUrl}/api/v1/inference`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          circuit_id: fixture.circuit_id,
          proof: fixture.proof,
          public_inputs: fixture.public_inputs,
          prompt: "In one sentence, what is MicoPay?",
        }),
      });
      const spendBody = (await spendRes.json()) as any;
      if (!spendRes.ok) {
        throw new Error(
          `Spend step failed (fixture may already be spent — regenerate WP-D1): ${spendRes.status} ${JSON.stringify(spendBody)}`,
        );
      }
      steps.push({
        name: "inference_spend",
        description:
          "Agent proves it holds a valid, unspent credential and spends it — without revealing which one, or who it is.",
        price_usdc: "0",
        soroban_tx_hash: spendBody.verify_tx_hash,
        soroban_explorer_url: spendBody.verify_tx_hash
          ? `${EXPLORER}/${spendBody.verify_tx_hash}`
          : undefined,
        result: spendBody,
      });

      // ── Step 3: Reuse — same proof again, MUST be rejected. This is the point. ─
      const reuseRes = await fetch(`${baseUrl}/api/v1/inference`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          circuit_id: fixture.circuit_id,
          proof: fixture.proof,
          public_inputs: fixture.public_inputs,
          prompt: "In one sentence, what is MicoPay?",
        }),
      });
      const reuseBody = (await reuseRes.json()) as any;
      steps.push({
        name: "inference_reuse_rejected",
        description:
          "Same proof, resubmitted. Rejected on-chain — one credential, one use, no reuse.",
        price_usdc: "0",
        rejected_as_expected: reuseRes.status === 409,
        result: reuseBody,
      });

      return reply.send({
        agent_address: agentAddress,
        platform_address: platformAddr,
        total_paid_usdc: "0.01",
        steps,
        summary:
          "Pay in public, spend in private — and nobody, not even MicoPay, can link the two.",
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({
        error: "ZK demo failed",
        detail: String(err),
        steps_completed: steps,
      });
    }
  });
}
