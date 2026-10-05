/**
 * setup-demo-agent.mjs
 *
 * Sets up a "demo agent" account on Stellar testnet with real USDC.
 * Run once: node scripts/setup-demo-agent.mjs
 *
 * What it does:
 *   1. Generate a new keypair (or reuse DEMO_AGENT_SECRET from .env)
 *   2. Fund with Friendbot (10,000 XLM testnet)
 *   3. Add USDC trustline (changeTrust)
 *   4. Swap XLM → USDC on the SDEX (pathPaymentStrictReceive)
 *   5. Print keys to add to apps/api/.env
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ENV_PATH = resolve(ROOT, "apps/api/.env");

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new StellarSdk.Asset("USDC", USDC_ISSUER);
const XLM = StellarSdk.Asset.native();

const server = new StellarSdk.Horizon.Server(HORIZON_URL);

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log("=== Micopay Demo Agent Setup ===\n");

  // 1. Load or generate keypair
  let envContent = readFileSync(ENV_PATH, "utf8");
  const existingSecret = envContent.match(/^DEMO_AGENT_SECRET_KEY=(.+)$/m)?.[1];

  let keypair;
  if (existingSecret && existingSecret.startsWith("S")) {
    keypair = StellarSdk.Keypair.fromSecret(existingSecret);
    console.log("✓ Reusing existing demo agent keypair");
  } else {
    keypair = StellarSdk.Keypair.random();
    console.log("✓ Generated new demo agent keypair");
  }

  console.log(`  Public:  ${keypair.publicKey()}`);
  console.log(`  Secret:  ${keypair.secret()}\n`);

  // 2. Fund with Friendbot
  let funded = false;
  try {
    const account = await server.loadAccount(keypair.publicKey());
    const xlmBalance = account.balances.find(b => b.asset_type === "native")?.balance ?? "0";
    console.log(`✓ Account exists — XLM balance: ${xlmBalance}`);
    funded = true;
  } catch {
    console.log("→ Funding with Friendbot...");
    const res = await fetch(`${FRIENDBOT_URL}?addr=${keypair.publicKey()}`);
    if (!res.ok) throw new Error(`Friendbot failed: ${await res.text()}`);
    console.log("✓ Friendbot funded (10,000 XLM)");
    await sleep(3000);
    funded = true;
  }

  if (!funded) throw new Error("Could not fund account");

  // 3. Check USDC trustline
  const account = await server.loadAccount(keypair.publicKey());
  const usdcBalance = account.balances.find(
    b => b.asset_type !== "native" && b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER
  );

  if (usdcBalance) {
    console.log(`✓ USDC trustline exists — balance: ${usdcBalance.balance} USDC`);
  } else {
    console.log("→ Adding USDC trustline...");
    const trustTx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: StellarSdk.Networks.TESTNET,
    })
      .addOperation(StellarSdk.Operation.changeTrust({ asset: USDC, limit: "100000" }))
      .setTimeout(180)
      .build();

    trustTx.sign(keypair);
    await server.submitTransaction(trustTx);
    console.log("✓ USDC trustline added");
    await sleep(3000);
  }

  // 4. Swap XLM → USDC if balance < 5
  const freshAccount = await server.loadAccount(keypair.publicKey());
  const currentUsdc = parseFloat(
    freshAccount.balances.find(
      b => b.asset_type !== "native" && b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER
    )?.balance ?? "0"
  );

  if (currentUsdc >= 5) {
    console.log(`✓ USDC balance sufficient: ${currentUsdc} USDC`);
  } else {
    const needed = 10; // Get 10 USDC
    console.log(`→ Swapping XLM → ${needed} USDC on SDEX...`);

    // Use pathPaymentStrictReceive: pay at most 200 XLM to get exactly 10 USDC
    const swapTx = new StellarSdk.TransactionBuilder(freshAccount, {
      fee: "10000", // Higher fee for SDEX
      networkPassphrase: StellarSdk.Networks.TESTNET,
    })
      .addOperation(StellarSdk.Operation.pathPaymentStrictReceive({
        sendAsset: XLM,
        sendMax: "200",        // max 200 XLM to spend
        destination: keypair.publicKey(),
        destAsset: USDC,
        destAmount: String(needed),
        path: [],              // direct path XLM→USDC
      }))
      .setTimeout(180)
      .build();

    swapTx.sign(keypair);
    try {
      const result = await server.submitTransaction(swapTx);
      console.log(`✓ Swap successful — got ${needed} USDC`);
      console.log(`  tx: https://stellar.expert/explorer/testnet/tx/${result.hash}`);
    } catch (e) {
      const extras = e?.response?.data?.extras;
      console.error("✗ Swap failed:", JSON.stringify(extras?.result_codes ?? e.message, null, 2));
      console.log("\n  ⚠ If SDEX has no liquidity, try getting USDC from:");
      console.log("    https://ultrastellar.com/faucet (testnet USDC faucet)");
    }
    await sleep(3000);
  }

  // 5. Final balance check
  const finalAccount = await server.loadAccount(keypair.publicKey());
  console.log("\n=== Final Balances ===");
  for (const b of finalAccount.balances) {
    const code = b.asset_type === "native" ? "XLM" : b.asset_code;
    console.log(`  ${code}: ${b.balance}`);
  }

  // 6. Update .env
  const addOrUpdate = (key, value) => {
    if (envContent.includes(`${key}=`)) {
      envContent = envContent.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);
    } else {
      envContent += `\n# Demo Agent (testnet)\n${key}=${value}\n`;
    }
  };

  addOrUpdate("DEMO_AGENT_SECRET_KEY", keypair.secret());
  addOrUpdate("DEMO_AGENT_PUBLIC_KEY", keypair.publicKey());
  addOrUpdate("USDC_ISSUER", USDC_ISSUER);

  writeFileSync(ENV_PATH, envContent);
  console.log("\n✓ Keys saved to apps/api/.env");
  console.log("\n=== Setup complete! ===");
  console.log(`  Demo agent: ${keypair.publicKey()}`);
  console.log(`  Explorer:   https://stellar.expert/explorer/testnet/account/${keypair.publicKey()}`);
}

main().catch(console.error);
