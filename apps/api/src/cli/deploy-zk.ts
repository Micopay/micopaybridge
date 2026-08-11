#!/usr/bin/env tsx
/**
 * Deploy and configure ZkVerifierRegistry on Stellar testnet.
 *
 * Usage:
 *   tsx src/cli/deploy-zk.ts deploy    --wasm <path>  [--network testnet]
 *   tsx src/cli/deploy-zk.ts init      --contract <id>
 *   tsx src/cli/deploy-zk.ts register  --contract <id>  (registers both circuits)
 *   tsx src/cli/deploy-zk.ts set-root  --contract <id> [--root <hex>]
 *   tsx src/cli/deploy-zk.ts full      --wasm <path>    (deploy + init + register + set-root)
 *
 * Required env vars:
 *   ADMIN_SECRET_KEY     Stellar secret key (the admin)
 *   SOROBAN_RPC_URL      (optional, defaults to testnet)
 *
 * After 'deploy', saves the contract ID to .env.zk (root of monorepo).
 */
import * as fs from "fs";
import * as path from "path";
import * as StellarSdk from "@stellar/stellar-sdk";
import { execSync } from "child_process";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const RPC_URL =
  process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NET = StellarSdk.Networks.TESTNET;

const VK_PATHS: Record<string, string> = {
  poseidon_preimage: path.join(
    REPO_ROOT,
    "circuits/poseidon_preimage/target/vk/vk"
  ),
  reputation_v1: path.join(
    REPO_ROOT,
    "circuits/reputation_v1/target/vk/vk"
  ),
  // Was missing here even though it's the circuit the live demo pipeline
  // actually spends (credentials.ts buy -> inference.ts spend) — a redeploy
  // via `register` alone would silently omit it.
  access_credential_v1: path.join(
    REPO_ROOT,
    "circuits/access_credential_v1/target/vk/vk"
  ),
};

const DEMO_ROOT =
  "0x079fa7cd6ecb9dc5b48eedf99357995c04771a815c19072ac63b0f1265868bd5";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function buildRpc() {
  const secretKey = process.env.ADMIN_SECRET_KEY;
  if (!secretKey) throw new Error("ADMIN_SECRET_KEY not set");
  const kp = StellarSdk.Keypair.fromSecret(secretKey);
  const rpc = new StellarSdk.rpc.Server(RPC_URL);
  return { kp, rpc };
}

async function invoke(
  rpc: StellarSdk.rpc.Server,
  kp: StellarSdk.Keypair,
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[]
): Promise<string> {
  const contract = new StellarSdk.Contract(contractId);
  const account = await rpc.getAccount(kp.publicKey());

  let tx = new StellarSdk.TransactionBuilder(account, {
    fee: "2000000",
    networkPassphrase: NET,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(180)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation error (${method}): ${sim.error}`);
  }
  tx = StellarSdk.rpc.assembleTransaction(tx, sim).build();
  tx.sign(kp);

  const sent = await rpc.sendTransaction(tx);
  if (sent.status === "ERROR") {
    throw new Error(
      `Send error (${method}): ${JSON.stringify(sent.errorResult)}`
    );
  }

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await rpc.getTransaction(sent.hash);
    if (s.status === "SUCCESS") return sent.hash;
    if (s.status === "FAILED")
      throw new Error(`Tx failed (${method}): ${sent.hash}`);
  }
  throw new Error(`Timeout waiting for tx (${method}): ${sent.hash}`);
}

function hexToBytes(hex: string): Buffer {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Buffer.from(h.padStart(64, "0"), "hex");
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdDeploy(args: string[]): Promise<string> {
  const wasmIdx = args.indexOf("--wasm");
  if (wasmIdx < 0) throw new Error("--wasm <path> required");
  const wasmPath = args[wasmIdx + 1];
  if (!fs.existsSync(wasmPath))
    throw new Error(`WASM not found: ${wasmPath}`);

  const { kp } = await buildRpc();
  const adminPub = kp.publicKey();

  console.log(`[deploy] Uploading + deploying ZkVerifierRegistry...`);
  console.log(`         WASM: ${wasmPath} (${fs.statSync(wasmPath).size} bytes)`);
  console.log(`         Admin: ${adminPub}`);

  // Use stellar CLI for deploy (handles upload + deploy in one command)
  const network =
    args.includes("--network") ? args[args.indexOf("--network") + 1] : "testnet";

  const result = execSync(
    `stellar contract deploy \
      --wasm "${wasmPath}" \
      --source-account "${process.env.ADMIN_SECRET_KEY}" \
      --network ${network} \
      --fee 2000000`,
    { encoding: "utf-8" }
  ).trim();

  // stellar contract deploy outputs just the contract ID
  const contractId = result.split("\n").find((l) => l.match(/^C[A-Z2-7]{55}$/));
  if (!contractId) throw new Error(`Could not parse contract ID from: ${result}`);

  console.log(`[ok] Contract deployed: ${contractId}`);

  // Save to .env.zk
  const envFile = path.join(REPO_ROOT, ".env.zk");
  fs.writeFileSync(envFile, `ZK_VERIFIER_CONTRACT_ID=${contractId}\n`);
  console.log(`[ok] Saved to .env.zk`);

  return contractId;
}

async function cmdInit(contractId: string): Promise<void> {
  const { kp, rpc } = await buildRpc();
  const adminVal = StellarSdk.xdr.ScVal.scvAddress(
    StellarSdk.Address.fromString(kp.publicKey()).toScAddress()
  );

  console.log(`[init] Initializing ZkVerifierRegistry admin = ${kp.publicKey()}`);
  const txHash = await invoke(rpc, kp, contractId, "init", [adminVal]);
  console.log(`[ok] init tx: ${txHash}`);
}

async function cmdRegister(contractId: string): Promise<void> {
  const { kp, rpc } = await buildRpc();

  for (const [circuitId, vkPath] of Object.entries(VK_PATHS)) {
    if (!fs.existsSync(vkPath)) {
      console.warn(`[skip] VK not found for ${circuitId}: ${vkPath}`);
      continue;
    }

    const vkBuf = fs.readFileSync(vkPath);
    console.log(`[register] ${circuitId} — VK ${vkBuf.length} bytes`);

    const circuitIdVal = StellarSdk.xdr.ScVal.scvSymbol(circuitId);
    const vkVal = StellarSdk.xdr.ScVal.scvBytes(vkBuf);

    const txHash = await invoke(rpc, kp, contractId, "register_circuit", [
      circuitIdVal,
      vkVal,
    ]);
    console.log(`[ok] ${circuitId} registered — tx: ${txHash}`);
  }
}

async function cmdSetRoot(contractId: string, args: string[]): Promise<void> {
  const rootIdx = args.indexOf("--root");
  const rootHex = rootIdx >= 0 ? args[rootIdx + 1] : DEMO_ROOT;

  const { kp, rpc } = await buildRpc();
  const rootBuf = hexToBytes(rootHex);
  const rootVal = StellarSdk.xdr.ScVal.scvBytes(rootBuf);

  console.log(`[set-root] Publishing merkle root: ${rootHex}`);
  const txHash = await invoke(rpc, kp, contractId, "set_reputation_root", [
    rootVal,
  ]);
  console.log(`[ok] set_reputation_root tx: ${txHash}`);
}

async function cmdFull(args: string[]): Promise<void> {
  const contractId = await cmdDeploy(args);
  await new Promise((r) => setTimeout(r, 4000)); // wait for contract to land
  await cmdInit(contractId);
  await cmdRegister(contractId);
  await cmdSetRoot(contractId, args);

  console.log("\n====================================================");
  console.log("ZkVerifierRegistry fully configured on testnet");
  console.log(`Contract:   ${contractId}`);
  console.log(`Admin:      ${StellarSdk.Keypair.fromSecret(process.env.ADMIN_SECRET_KEY!).publicKey()}`);
  console.log(`Circuits:   poseidon_preimage, reputation_v1`);
  console.log(`Root:       ${DEMO_ROOT}`);
  console.log("====================================================");
  console.log("\nNext: set ZK_VERIFIER_CONTRACT_ID in your .env and run Demo B");
}

// ── Entry point ───────────────────────────────────────────────────────────────

const [, , cmd, ...rest] = process.argv;

const contractId = rest[rest.indexOf("--contract") + 1] ?? "";

(async () => {
  switch (cmd) {
    case "deploy":
      await cmdDeploy(rest);
      break;
    case "init":
      if (!contractId) throw new Error("--contract <id> required");
      await cmdInit(contractId);
      break;
    case "register":
      if (!contractId) throw new Error("--contract <id> required");
      await cmdRegister(contractId);
      break;
    case "set-root":
      if (!contractId) throw new Error("--contract <id> required");
      await cmdSetRoot(contractId, rest);
      break;
    case "full":
      await cmdFull(rest);
      break;
    default:
      console.log(`
ZkVerifierRegistry Deploy CLI

Commands:
  deploy    --wasm <path>                 Upload WASM + deploy contract
  init      --contract <id>              Set admin to ADMIN_SECRET_KEY address
  register  --contract <id>              Register VKs for all circuits
  set-root  --contract <id> [--root <hex>]  Publish demo Merkle root
  full      --wasm <path>                All of the above in sequence

Env:
  ADMIN_SECRET_KEY    Stellar secret key
  SOROBAN_RPC_URL     (optional)

WASM path (after cargo build):
  contracts/zk-verifier/target/wasm32v1-none/release/zk_verifier.wasm
`);
  }
})().catch((err) => {
  console.error("[fatal]", err instanceof Error ? err.message : err);
  process.exit(1);
});
