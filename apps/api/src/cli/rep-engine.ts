#!/usr/bin/env tsx
/**
 * Reputation Engine CLI
 *
 * Manages the off-chain Merkle tree of user reputation and publishes roots
 * to the ZkVerifierRegistry Soroban contract.
 *
 * Usage:
 *   tsx src/cli/rep-engine.ts build-tree --seed <path>  [--out <dir>]
 *   tsx src/cli/rep-engine.ts publish-root              [--root-file <path>]
 *   tsx src/cli/rep-engine.ts nullifier --user <id> --context <dec>
 *
 * Hash function: BN254 Pedersen (std::hash::pedersen_hash in Noir 1.0.0-beta.9)
 * Tree values are pre-computed in circuits/reputation_v1 via:
 *   nargo test compute_demo_values --show-output
 * and stored in apps/api/demo/demo_tree.json.
 */
import * as fs from "fs";
import * as path from "path";
import * as StellarSdk from "@stellar/stellar-sdk";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const DEMO_TREE_PATH = path.join(
  REPO_ROOT,
  "apps/api/demo/demo_tree.json"
);
const CIRCUITS_DIR = path.join(REPO_ROOT, "circuits/reputation_v1");

// ── Types ────────────────────────────────────────────────────────────────────

interface DemoUser {
  secret: string;
  tier: number;
  tier_name: string;
  leaf?: string;
  merkle_root?: string;
  path_elements: string[];
  path_index: number[];
  nullifiers?: Record<string, string>;
}

interface DemoTree {
  merkle_root: string;
  users: Record<string, DemoUser>;
}

interface SeedUser {
  id: string;
  secret: string;
  tier: number;
  tier_name: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadDemoTree(): DemoTree {
  if (!fs.existsSync(DEMO_TREE_PATH)) {
    throw new Error(
      `demo_tree.json not found at ${DEMO_TREE_PATH}.\n` +
        "Run: nargo test compute_demo_values --show-output (in circuits/reputation_v1)"
    );
  }
  return JSON.parse(fs.readFileSync(DEMO_TREE_PATH, "utf-8")) as DemoTree;
}

function hexToRootBytes(hex: string): Buffer {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Buffer.from(clean.padStart(64, "0"), "hex");
}

function makeProverToml(
  user: DemoUser,
  tierThreshold: number,
  context: string,
  nullifier: string
): string {
  const pathEls = user.path_elements.map((e) => `"${e}"`).join(",");
  const pathIdx = user.path_index.join(",");
  const root = user.merkle_root ?? loadDemoTree().merkle_root;

  return [
    `secret = "${user.secret}"`,
    `tier = "${user.tier}"`,
    `path_elements = [${pathEls}]`,
    `path_index = [${pathIdx}]`,
    `merkle_root = "${root}"`,
    `tier_threshold = "${tierThreshold}"`,
    `context = "${context}"`,
    `nullifier = "${nullifier}"`,
  ].join("\n");
}

async function publishRoot(rootHex: string): Promise<string> {
  const contractId = process.env.ZK_VERIFIER_CONTRACT_ID;
  if (!contractId) throw new Error("ZK_VERIFIER_CONTRACT_ID not set");
  const secretKey = process.env.ADMIN_SECRET_KEY;
  if (!secretKey) throw new Error("ADMIN_SECRET_KEY not set");

  const rpc = new StellarSdk.rpc.Server(
    process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org"
  );
  const kp = StellarSdk.Keypair.fromSecret(secretKey);
  const account = await rpc.getAccount(kp.publicKey());
  const contract = new StellarSdk.Contract(contractId);

  const rootBuf = hexToRootBytes(rootHex);
  const rootVal = StellarSdk.xdr.ScVal.scvBytes(rootBuf);

  let tx = new StellarSdk.TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(contract.call("set_reputation_root", rootVal))
    .setTimeout(180)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }
  tx = StellarSdk.rpc.assembleTransaction(tx, sim).build();
  tx.sign(kp);

  const sent = await rpc.sendTransaction(tx);
  if (sent.status === "ERROR") {
    throw new Error(`Send failed: ${JSON.stringify(sent.errorResult)}`);
  }

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await rpc.getTransaction(sent.hash);
    if (status.status === "SUCCESS") return sent.hash;
    if (status.status === "FAILED") throw new Error(`Tx failed: ${sent.hash}`);
  }
  throw new Error(`Timeout: ${sent.hash}`);
}

// ── Commands ─────────────────────────────────────────────────────────────────

function cmdBuildTree(args: string[]): void {
  const seedIdx = args.indexOf("--seed");
  const outIdx = args.indexOf("--out");
  const userIdx = args.indexOf("--user");
  const ctxIdx = args.indexOf("--context");
  const thrIdx = args.indexOf("--threshold");

  const seedFile = seedIdx >= 0 ? args[seedIdx + 1] : path.join(REPO_ROOT, "apps/api/demo/demo_users.json");
  const outDir = outIdx >= 0 ? args[outIdx + 1] : path.join(REPO_ROOT, "apps/api/demo/merkle_data");
  const targetUser = userIdx >= 0 ? args[userIdx + 1] : null;
  const context = ctxIdx >= 0 ? args[ctxIdx + 1] : "42";
  const tierThreshold = thrIdx >= 0 ? parseInt(args[thrIdx + 1], 10) : 2;

  const seed = JSON.parse(fs.readFileSync(seedFile, "utf-8")) as {
    users: SeedUser[];
  };
  const tree = loadDemoTree();

  let wroteProverToml = false;

  for (const seedUser of seed.users) {
    if (targetUser && seedUser.id !== targetUser) continue;

    const treeUser = tree.users[seedUser.id];
    if (!treeUser) {
      console.warn(`[warn] ${seedUser.id} not found in demo_tree.json — skipping`);
      continue;
    }

    const nullifier =
      treeUser.nullifiers?.[context] ??
      `[run: nargo test compute_nullifier_${seedUser.id}_${context} --show-output]`;

    const userOutDir = path.join(outDir, seedUser.id);
    fs.mkdirSync(userOutDir, { recursive: true });

    const toml = makeProverToml(treeUser, tierThreshold, context, nullifier);
    fs.writeFileSync(path.join(userOutDir, "Prover.toml"), toml);

    // Also copy to the circuit directory for nargo execute
    if (!wroteProverToml || seedUser.id === "alice") {
      fs.writeFileSync(path.join(CIRCUITS_DIR, "Prover.toml"), toml);
      console.log(`[info] Wrote circuits/reputation_v1/Prover.toml for ${seedUser.id}`);
      wroteProverToml = true;
    }

    // Store root
    fs.writeFileSync(path.join(outDir, "root.txt"), tree.merkle_root);

    console.log(
      `[ok] ${seedUser.id} (${treeUser.tier_name}) — Prover.toml written to ${userOutDir}/`
    );
  }

  const root = tree.merkle_root;
  console.log(`\n[tree] merkle_root = ${root}`);
  console.log(`[tree] root saved to ${outDir}/root.txt`);
  console.log("\nNext steps:");
  console.log("  1. npm run rep:publish-root   (deploys root on Soroban)");
  console.log("  2. Run demo_b.sh to generate proof and verify");
}

async function cmdPublishRoot(args: string[]): Promise<void> {
  const rootFileIdx = args.indexOf("--root-file");
  const rootHexIdx = args.indexOf("--root");

  let rootHex: string;

  if (rootHexIdx >= 0) {
    rootHex = args[rootHexIdx + 1];
  } else {
    const rootFile =
      rootFileIdx >= 0
        ? args[rootFileIdx + 1]
        : path.join(REPO_ROOT, "apps/api/demo/merkle_data/root.txt");

    if (!fs.existsSync(rootFile)) {
      throw new Error(`root.txt not found at ${rootFile}. Run build-tree first.`);
    }
    rootHex = fs.readFileSync(rootFile, "utf-8").trim();
  }

  console.log(`[publish] Publishing root ${rootHex}...`);
  const txHash = await publishRoot(rootHex);
  console.log(`[ok] set_reputation_root tx: ${txHash}`);
  console.log(
    `     https://stellar.expert/explorer/testnet/tx/${txHash}`
  );
}

function cmdNullifier(args: string[]): void {
  const userIdx = args.indexOf("--user");
  const ctxIdx = args.indexOf("--context");
  const userId = userIdx >= 0 ? args[userIdx + 1] : null;
  const context = ctxIdx >= 0 ? args[ctxIdx + 1] : "42";

  const tree = loadDemoTree();

  if (userId) {
    const u = tree.users[userId];
    if (!u) throw new Error(`Unknown user: ${userId}`);
    const n = u.nullifiers?.[context];
    if (!n) {
      console.error(
        `[warn] No pre-computed nullifier for ${userId} context=${context}.`
      );
      console.error(
        "Run: nargo test compute_demo_values --show-output (add context to the test)"
      );
      process.exit(1);
    }
    console.log(n);
  } else {
    for (const [id, u] of Object.entries(tree.users)) {
      const n = u.nullifiers?.[context] ?? "(not pre-computed)";
      console.log(`${id}: ${n}`);
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

const [, , cmd, ...rest] = process.argv;

if (!cmd || cmd === "--help" || cmd === "-h") {
  console.log(`
Reputation Engine CLI

Commands:
  build-tree  --seed <file>  [--out <dir>] [--user <id>] [--context <dec>] [--threshold <n>]
              Build demo Merkle tree, output Prover.toml files
  publish-root               [--root-file <path>] [--root <hex>]
              Publish Merkle root to ZkVerifierRegistry on Soroban
  nullifier   --user <id>    [--context <dec>]
              Print pre-computed nullifier for a demo user

Env vars required for publish-root:
  ZK_VERIFIER_CONTRACT_ID  Deployed ZkVerifierRegistry contract address
  ADMIN_SECRET_KEY         Stellar secret key with admin rights
  SOROBAN_RPC_URL          (optional, defaults to testnet)
`);
  process.exit(0);
}

(async () => {
  switch (cmd) {
    case "build-tree":
      cmdBuildTree(rest);
      break;
    case "publish-root":
      await cmdPublishRoot(rest);
      break;
    case "nullifier":
      cmdNullifier(rest);
      break;
    default:
      console.error(`Unknown command: ${cmd}. Use --help.`);
      process.exit(1);
  }
})().catch((err) => {
  console.error("[fatal]", err instanceof Error ? err.message : err);
  process.exit(1);
});
