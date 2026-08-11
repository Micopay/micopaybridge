#!/usr/bin/env tsx
/**
 * Demo B — End-to-end ZKaaS on-chain verification
 *
 * Reads alice_proof.bin, constructs public inputs, calls ZkVerifierRegistry.verify()
 * on Stellar testnet, and prints the result.
 *
 * Usage:
 *   npx tsx src/cli/verify-demo.ts
 *
 * Env:
 *   ADMIN_SECRET_KEY   (alice's key)
 *   ZK_VERIFIER_CONTRACT_ID
 */
import * as fs from "fs";
import * as path from "path";
import * as StellarSdk from "@stellar/stellar-sdk";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const RPC_URL =
  process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NET = StellarSdk.Networks.TESTNET;

const DEMO_ROOT =
  "0x079fa7cd6ecb9dc5b48eedf99357995c04771a815c19072ac63b0f1265868bd5";
const DEMO_NULLIFIER =
  "0x1b7d99efaf246eb3489deefcff6b29541e57fbc7c048da3713b00df3e84eccc2";
const TIER_THRESHOLD = "2";
const CONTEXT = "42";

function hexToDec(hex: string): string {
  return BigInt(hex).toString(10);
}

function encodePublicInputs(inputs: string[]): Buffer {
  const bufs = inputs.map((v) => {
    const hex = BigInt(v).toString(16).padStart(64, "0");
    return Buffer.from(hex, "hex");
  });
  return Buffer.concat(bufs);
}

async function main() {
  const secretKey = process.env.ADMIN_SECRET_KEY;
  const contractId =
    process.env.ZK_VERIFIER_CONTRACT_ID ??
    "CC6YHSKDTINV4XSZNVT42XW4GPJIANNKNNKG73HYTO2OJ7DPF55A33UG";

  if (!secretKey) {
    console.error("[fatal] ADMIN_SECRET_KEY not set");
    process.exit(1);
  }

  const proofPath = path.join(REPO_ROOT, "apps/api/demo/alice_proof.bin");
  if (!fs.existsSync(proofPath)) {
    console.error(`[fatal] Proof not found: ${proofPath}`);
    console.error("  Run: wsl -d Ubuntu-24.04 -u ericm98 -- bash -c \"~/.bb/bb prove ...\"");
    process.exit(1);
  }

  const proofBuf = fs.readFileSync(proofPath);
  console.log("======================================================================");
  console.log("  Demo B — ZKaaS Anonymous Reputation (MicoPay x Stellar)");
  console.log("======================================================================");
  console.log(`  Contract:     ${contractId}`);
  console.log(`  Circuit:      reputation_v1`);
  console.log(`  Prover:       alice (GOLD tier, secret=1001)`);
  console.log(`  Proof:        ${proofBuf.length} bytes`);
  console.log(`  Merkle root:  ${DEMO_ROOT.slice(0, 18)}...`);
  console.log(`  Tier >= :     SILVER (threshold=${TIER_THRESHOLD})`);
  console.log(`  Nullifier:    ${DEMO_NULLIFIER.slice(0, 18)}...`);
  console.log("======================================================================");
  console.log();

  // Public inputs: [merkle_root, tier_threshold, context, nullifier] as decimal strings
  const publicInputsDecimal = [
    hexToDec(DEMO_ROOT),
    TIER_THRESHOLD,
    CONTEXT,
    hexToDec(DEMO_NULLIFIER),
  ];

  const kp = StellarSdk.Keypair.fromSecret(secretKey);
  const rpc = new StellarSdk.rpc.Server(RPC_URL);
  const account = await rpc.getAccount(kp.publicKey());
  const contract = new StellarSdk.Contract(contractId);

  const circuitIdVal = StellarSdk.xdr.ScVal.scvSymbol("reputation_v1");
  const inputsBuf = encodePublicInputs(publicInputsDecimal);
  const inputsVal = StellarSdk.xdr.ScVal.scvBytes(inputsBuf);
  const proofVal = StellarSdk.xdr.ScVal.scvBytes(proofBuf);

  console.log("[1/3] Simulating on-chain ZK verification...");

  let tx = new StellarSdk.TransactionBuilder(account, {
    fee: "2000000",
    networkPassphrase: NET,
  })
    .addOperation(contract.call("verify", circuitIdVal, inputsVal, proofVal))
    .setTimeout(180)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    console.error("[fatal] Simulation error:", sim.error);
    process.exit(1);
  }
  console.log("[ok] Simulation passed");

  tx = StellarSdk.rpc.assembleTransaction(tx, sim).build();
  tx.sign(kp);

  console.log("[2/3] Submitting transaction to Stellar testnet...");
  const sent = await rpc.sendTransaction(tx);
  if (sent.status === "ERROR") {
    console.error("[fatal] Send error:", sent.errorResult);
    process.exit(1);
  }
  console.log(`  tx hash: ${sent.hash}`);

  console.log("[3/3] Waiting for confirmation...");
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await rpc.getTransaction(sent.hash);
    if (s.status === "SUCCESS") {
      console.log();
      console.log("======================================================================");
      console.log("  RESULT: PROOF VERIFIED ON-CHAIN ✓");
      console.log();
      console.log("  What Agent B (market-maker) now knows:");
      console.log("  ✓  Counterparty reputation tier >= SILVER");
      console.log("  ✗  NOT: who the counterparty is");
      console.log("  ✗  NOT: their exact tier or Stellar address");
      console.log("  ✗  NOT: their secret or any other identity info");
      console.log();
      console.log("  Trade can proceed: A commits to HTLC via poseidon_preimage circuit");
      console.log("  ZKaaS fee: 0.001 USDC (via x402, pay-per-use)");
      console.log("======================================================================");
      console.log();
      console.log(`  Stellar testnet tx: https://stellar.expert/explorer/testnet/tx/${sent.hash}`);
      return;
    }
    if (s.status === "FAILED") {
      console.error("\n[FAIL] On-chain verification FAILED — proof invalid or contract error");
      console.error(`  tx: ${sent.hash}`);
      process.exit(1);
    }
  }
  console.error("[timeout] Tx not confirmed after 80s");
  process.exit(1);
}

main().catch((err) => {
  console.error("[fatal]", err instanceof Error ? err.message : err);
  process.exit(1);
});
