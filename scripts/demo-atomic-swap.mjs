/**
 * demo-atomic-swap.mjs
 *
 * Executes a real AtomicSwap HTLC on Stellar testnet:
 *
 *   Platform  →  locks USDC in Contract A  (initiator)
 *   Agent     →  locks XLM  in Contract B  (counterparty of A, initiator of B)
 *   Platform  →  reveals secret on B  →  gets XLM
 *   Agent     →  uses public secret on A  →  gets USDC
 *
 * All 4 transactions are submitted to testnet and verifiable on stellar.expert.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import crypto from "crypto";

// ── Config ────────────────────────────────────────────────────────────────────
const PLATFORM_SECRET = "SAZKNOUDZT2KSPZI7OSCTVNZY2KDUHGLP3RFEXIJIMMZPFZ7LLX7FFQD";
const AGENT_SECRET    = "SBKCRFTEIS6JS5MXRHQGLYOCENCV3Z4FFKVGI3EDEVWVZLGH32T4PRRC";
const CONTRACT_A      = "CCDOUXIXSFXT2HTJAJGFNUJN6CKCYX2M6AL2BHHPEF6ISNHP2BGLS4KX";
const CONTRACT_B      = "CBLCGG44QQILWEIVBXDSZSLH7NI7SGJQKXQ7WTKP3W3YSXOBTGMZKSNN";
const USDC_ISSUER     = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const RPC     = new StellarSdk.rpc.Server("https://soroban-testnet.stellar.org");
const HORIZON = new StellarSdk.Horizon.Server("https://horizon-testnet.stellar.org");
const NET     = StellarSdk.Networks.TESTNET;

const platformKP = StellarSdk.Keypair.fromSecret(PLATFORM_SECRET);
const agentKP    = StellarSdk.Keypair.fromSecret(AGENT_SECRET);

// SAC addresses (deterministic from asset + network)
const USDC_SAC = new StellarSdk.Asset("USDC", USDC_ISSUER).contractId(NET);
const XLM_SAC  = StellarSdk.Asset.native().contractId(NET);

const STROOP = 10_000_000n; // 1 unit = 10^7 (7 decimal places)

function link(hash) {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Soroban call helpers ──────────────────────────────────────────────────────
function addressVal(str) {
  return StellarSdk.Address.fromString(str).toScVal();
}
function i128Val(n) {
  return StellarSdk.nativeToScVal(BigInt(n), { type: "i128" });
}
function u32Val(n) {
  return StellarSdk.nativeToScVal(n, { type: "u32" });
}
function bytesNVal(hexStr) {
  return StellarSdk.xdr.ScVal.scvBytes(Buffer.from(hexStr, "hex"));
}
function bytesVal(hexStr) {
  return StellarSdk.xdr.ScVal.scvBytes(Buffer.from(hexStr, "hex"));
}

async function invokeContract(signerKP, contractId, method, args) {
  const account  = await RPC.getAccount(signerKP.publicKey());
  const contract = new StellarSdk.Contract(contractId);

  let tx = new StellarSdk.TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: NET,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(180)
    .build();

  const sim = await RPC.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation error on ${method}: ${sim.error}`);
  }

  tx = StellarSdk.rpc.assembleTransaction(tx, sim).build();
  tx.sign(signerKP);

  const result = await RPC.sendTransaction(tx);
  if (result.status === "ERROR") throw new Error(`Send error: ${JSON.stringify(result.errorResult)}`);

  // Poll for confirmation
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const status = await RPC.getTransaction(result.hash);
    if (status.status === "SUCCESS") return result.hash;
    if (status.status === "FAILED")  throw new Error(`Tx failed: ${result.hash}`);
  }
  throw new Error(`Timeout waiting for tx: ${result.hash}`);
}

// ── Balances ──────────────────────────────────────────────────────────────────
async function getUsdcBalance(pubkey) {
  const account = await HORIZON.loadAccount(pubkey);
  const b = account.balances.find(b => b.asset_type !== "native" && b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER);
  return parseFloat(b?.balance ?? "0");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║       Micopay — Real AtomicSwap HTLC on Testnet     ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  console.log("Accounts:");
  console.log(`  Platform (initiator A): ${platformKP.publicKey()}`);
  console.log(`  Agent    (initiator B): ${agentKP.publicKey()}`);
  console.log(`  Contract A (USDC):      ${CONTRACT_A}`);
  console.log(`  Contract B (XLM):       ${CONTRACT_B}`);
  console.log(`  USDC SAC:               ${USDC_SAC}`);
  console.log(`  XLM SAC:                ${XLM_SAC}\n`);

  // Check balances
  const platformUsdc = await getUsdcBalance(platformKP.publicKey());
  const agentUsdc    = await getUsdcBalance(agentKP.publicKey());
  console.log(`Balances:`);
  console.log(`  Platform USDC: ${platformUsdc}`);
  console.log(`  Agent    USDC: ${agentUsdc}`);

  // If platform has less than 0.50 USDC, top up from agent
  if (platformUsdc < 0.50) {
    console.log("\n→ Topping up platform with 1 USDC from agent...");
    const { Keypair, Asset, TransactionBuilder, Operation, Networks, BASE_FEE } = StellarSdk;
    const acct = await HORIZON.loadAccount(agentKP.publicKey());
    const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NET })
      .addOperation(Operation.payment({
        destination: platformKP.publicKey(),
        asset: new Asset("USDC", USDC_ISSUER),
        amount: "1",
      }))
      .setTimeout(180).build();
    tx.sign(agentKP);
    const r = await HORIZON.submitTransaction(tx);
    console.log(`✓ Topped up — tx: ${link(r.hash)}`);
    await sleep(3000);
  }

  // ── Step 1: Generate secret ──────────────────────────────────────────────
  console.log("\n══ Step 1: Generate cryptographic secret ══");
  const secretBytes = crypto.randomBytes(32);
  const secret      = secretBytes.toString("hex");
  const secretHash  = crypto.createHash("sha256").update(secretBytes).digest("hex");
  console.log(`  secret:      ${secret.slice(0,16)}...${secret.slice(-8)} (kept private)`);
  console.log(`  secret_hash: ${secretHash.slice(0,16)}...${secretHash.slice(-8)} (public)`);

  // Swap amounts: 0.50 USDC ↔ ~3 XLM (at ~6.12 rate)
  const usdcAmount = 5_000_000n;  // 0.5 USDC (i128 with 7 decimals)
  const xlmAmount  = 30_000_000n; // 3.0 XLM
  console.log(`  Swap: 0.50 USDC ↔ 3.00 XLM`);

  // ── Step 2: Platform locks USDC in Contract A ───────────────────────────
  console.log("\n══ Step 2: Platform locks 0.50 USDC in Contract A ══");
  const lockAHash = await invokeContract(platformKP, CONTRACT_A, "lock", [
    addressVal(platformKP.publicKey()),  // initiator
    addressVal(agentKP.publicKey()),     // counterparty
    addressVal(USDC_SAC),               // token
    i128Val(usdcAmount),                // amount
    bytesNVal(secretHash),              // secret_hash
    u32Val(240),                        // timeout_ledgers (initiator: 2x)
  ]);
  console.log(`✓ USDC locked! tx: ${link(lockAHash)}`);

  // ── Step 3: Agent locks XLM in Contract B ───────────────────────────────
  console.log("\n══ Step 3: Agent locks 3.00 XLM in Contract B ══");
  const lockBHash = await invokeContract(agentKP, CONTRACT_B, "lock", [
    addressVal(agentKP.publicKey()),    // initiator
    addressVal(platformKP.publicKey()), // counterparty
    addressVal(XLM_SAC),               // token
    i128Val(xlmAmount),                // amount
    bytesNVal(secretHash),             // same secret_hash!
    u32Val(120),                       // timeout_ledgers (counterparty: 1x)
  ]);
  console.log(`✓ XLM locked! tx: ${link(lockBHash)}`);

  // ── Step 4: Platform reveals secret on B → gets XLM ─────────────────────
  console.log("\n══ Step 4: Platform reveals secret on Contract B → claims XLM ══");
  const relBHash = await invokeContract(platformKP, CONTRACT_B, "release", [
    bytesNVal(crypto.createHash("sha256").update(Buffer.from(secretHash, "hex")).digest("hex")), // swap_id
    bytesVal(secret), // secret revealed on-chain!
  ]);
  console.log(`✓ Platform claimed XLM! Secret revealed on-chain.`);
  console.log(`  tx: ${link(relBHash)}`);

  // ── Step 5: Agent uses revealed secret on A → gets USDC ─────────────────
  console.log("\n══ Step 5: Agent uses public secret on Contract A → claims USDC ══");
  const relAHash = await invokeContract(agentKP, CONTRACT_A, "release", [
    bytesNVal(crypto.createHash("sha256").update(Buffer.from(secretHash, "hex")).digest("hex")), // swap_id
    bytesVal(secret), // same secret
  ]);
  console.log(`✓ Agent claimed USDC! Swap complete.`);
  console.log(`  tx: ${link(relAHash)}`);

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║              Atomic Swap Complete ✓                  ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`\n  Lock USDC (A):   ${link(lockAHash)}`);
  console.log(`  Lock XLM  (B):   ${link(lockBHash)}`);
  console.log(`  Release B (XLM): ${link(relBHash)}`);
  console.log(`  Release A (USDC):${link(relAHash)}`);
  console.log(`\n  0.50 USDC ↔ 3.00 XLM — trustless, on-chain, atomic.`);
  console.log(`  No custodian. No bridge. Cryptography only.\n`);
}

main().catch(e => {
  console.error("\n✗ Error:", e.message ?? e);
  process.exit(1);
});
