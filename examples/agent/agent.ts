#!/usr/bin/env tsx
/**
 * Example Base agent — the BASE_IMPLEMENTATION_PLAN_2026-07.md WP4 demo.
 *
 * Discovers MicoPay's ZK credential purchase over x402, pays in USDC on
 * Base Sepolia (EIP-3009, gasless — the agent only signs, never submits a
 * transaction or holds Base ETH), receives an anonymous access credential,
 * and — once you've generated a ZK proof for it — spends it at
 * /api/v1/inference. The agent never touches a Stellar account at any
 * point: it pays on Base, and MicoPay does the trust verification and
 * settlement on Stellar/Soroban behind the API.
 *
 * Usage:
 *   npm install
 *   cp .env.example .env   # fill in AGENT_PRIVATE_KEY (Base Sepolia USDC, no ETH needed)
 *   npm start
 *
 * The ZK proof step is manual: no Pedersen-hash/Merkle-tree implementation
 * exists in JS in this repo (see docs/zk-agent-credentials/STATUS.md) —
 * proof generation is nargo/bb only. This script buys the credential, then
 * prints the exact commands to run; re-run with SPEND_PROOF_B64 and
 * SPEND_PUBLIC_INPUTS set (see .env.example) to complete the spend leg.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

// No dependency on dotenv — same manual .env loader apps/api/src/config.ts uses.
function loadEnv() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envPath = join(__dirname, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnv();

const API_URL = process.env.MICOPAY_API_URL ?? "http://localhost:3000";
const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
const BASE_USDC_ADDRESS = (process.env.BASE_USDC_ADDRESS ??
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as `0x${string}`;
// Must match middleware/x402.ts's default exactly, or signatures will
// verify off-chain but revert on-chain ("FiatTokenV2: invalid signature") —
// confirmed live during WP4 smoke testing. This default (name()="USDC", not
// Circle's usual "USD Coin") is specific to BASE_USDC_ADDRESS's deployment.
const BASE_USDC_DOMAIN_NAME = process.env.BASE_USDC_DOMAIN_NAME ?? "USDC";
const BASE_USDC_DOMAIN_VERSION = process.env.BASE_USDC_DOMAIN_VERSION ?? "2";
const BASE_CHAIN_ID = parseInt(process.env.BASE_CHAIN_ID ?? "84532", 10);
const PROMPT = process.env.PROMPT ?? "In one sentence, what is MicoPay?";

if (!AGENT_PRIVATE_KEY) {
  console.error(
    "Set AGENT_PRIVATE_KEY in .env — a testnet-only EVM key funded with Base Sepolia USDC (no ETH needed)."
  );
  process.exit(1);
}

const account = privateKeyToAccount(AGENT_PRIVATE_KEY as `0x${string}`);

interface AcceptsEntry {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payTo: string;
  asset: string;
}

interface Authorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}

async function discoverBasePaymentRequirements(): Promise<AcceptsEntry> {
  console.log("[1/4] Discovering MicoPay's credential-purchase payment requirements...");
  const res = await fetch(`${API_URL}/api/v1/credentials/buy`, { method: "POST" });
  if (res.status !== 402) {
    throw new Error(`Expected 402 Payment Required, got ${res.status}`);
  }
  const body = (await res.json()) as { accepts?: AcceptsEntry[] };
  const baseOption = body.accepts?.find((a) => a.network === "base-sepolia");
  if (!baseOption) {
    throw new Error(
      "MicoPay did not advertise a base-sepolia payment option — is X402_ACCEPT_CHAINS set to include base on the API?"
    );
  }
  console.log(`      -> pay ${baseOption.maxAmountRequired} base units of USDC to ${baseOption.payTo}`);
  return baseOption;
}

async function buildAndSignPaymentHeader(payTo: `0x${string}`, value: string): Promise<string> {
  console.log("[2/4] Signing an EIP-3009 authorization (gasless — no Base ETH needed)...");
  const now = Math.floor(Date.now() / 1000);
  const authorization: Authorization = {
    from: account.address,
    to: payTo,
    value,
    validAfter: String(now - 60),
    validBefore: String(now + 300),
    nonce: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
  };

  const signature = await account.signTypedData({
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
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });

  const payload = {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: { signature, authorization },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

interface Credential {
  payer: string;
  credential: {
    secret: string;
    circuit_id: string;
    public_inputs: [string, string]; // [merkle_root, nullifier]
    path_elements: string[];
    path_index: number[];
  };
}

async function buyCredential(paymentHeader: string): Promise<Credential> {
  console.log("[3/4] Paying and buying the anonymous credential...");
  const res = await fetch(`${API_URL}/api/v1/credentials/buy`, {
    method: "POST",
    headers: { "X-Payment": paymentHeader, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Purchase failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body as Credential;
}

async function spendCredential(proofB64: string, publicInputs: string[]): Promise<{ completion: string }> {
  console.log("[4/4] Spending the credential at /api/v1/inference...");
  const res = await fetch(`${API_URL}/api/v1/inference`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proof: proofB64, public_inputs: publicInputs, prompt: PROMPT }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Spend failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

function printProverInstructions(purchase: Credential) {
  const { secret, path_elements, path_index, public_inputs } = purchase.credential;
  console.log(`
Credential purchased — but generating the ZK proof needs the nargo/bb
toolchain (no JS Pedersen-hash implementation exists in this repo):

  1. cd circuits/access_credential_v1
  2. Write Prover.toml:
     secret = "${secret}"
     path_elements = [${path_elements.map((e) => `"${e}"`).join(",")}]
     path_index = [${path_index.join(",")}]
     merkle_root = "${public_inputs[0]}"
     nullifier = "${public_inputs[1]}"
  3. nargo execute witness
  4. bb prove --scheme ultra_honk --oracle_hash keccak \\
       -b target/access_credential_v1.json -w target/witness.gz -o pd
  5. base64 the flat proof file, then re-run this script with:
       SPEND_PROOF_B64=<base64 proof>
       SPEND_PUBLIC_INPUTS=${public_inputs[0]},${public_inputs[1]}
     (set both in examples/agent/.env, or export them, then npm start again)
`);
}

async function main() {
  const { payTo, maxAmountRequired } = await discoverBasePaymentRequirements();
  const paymentHeader = await buildAndSignPaymentHeader(payTo as `0x${string}`, maxAmountRequired);
  const purchase = await buyCredential(paymentHeader);
  console.log(`      -> credential purchased. payer (Base address): ${purchase.payer}`);

  const proofB64 = process.env.SPEND_PROOF_B64;
  const publicInputsRaw = process.env.SPEND_PUBLIC_INPUTS;

  if (!proofB64 || !publicInputsRaw) {
    printProverInstructions(purchase);
    console.log("Stopping here — no ZK proof provided yet. This agent never touched a Stellar account.");
    return;
  }

  const publicInputs = publicInputsRaw.split(",").map((s) => s.trim());
  const result = await spendCredential(proofB64, publicInputs);
  console.log(`\nClaude's response:\n${result.completion}`);
  console.log(
    "\nDone. This agent paid in USDC on Base and never touched a Stellar account — " +
      "MicoPay verified anonymous trust and settled on Stellar/Soroban behind the API."
  );
}

main().catch((err) => {
  console.error("[fatal]", err instanceof Error ? err.message : err);
  process.exit(1);
});
