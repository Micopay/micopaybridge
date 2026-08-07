/**
 * Soroban contract invocation helpers.
 * Ported from scripts/demo-atomic-swap.mjs to TypeScript.
 *
 * Executes the 4-step AtomicSwap HTLC flow:
 *   1. Initiator locks sell_asset in Contract A
 *   2. Counterparty locks buy_asset in Contract B (same secret_hash)
 *   3. Initiator reveals secret on B → gets buy_asset
 *   4. Counterparty uses public secret on A → gets sell_asset
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import crypto from "crypto";
import { swapStore, type SwapState } from "./swapStore.js";

const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NET      = StellarSdk.Networks.TESTNET;

const USDC_ISSUER = process.env.USDC_ISSUER ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC_SAC    = new StellarSdk.Asset("USDC", USDC_ISSUER).contractId(NET);
const XLM_SAC     = StellarSdk.Asset.native().contractId(NET);

function tokenSac(asset: string): string {
  return asset === "XLM" ? XLM_SAC : USDC_SAC;
}

function addressVal(str: string): StellarSdk.xdr.ScVal {
  return StellarSdk.Address.fromString(str).toScVal();
}
function i128Val(n: bigint): StellarSdk.xdr.ScVal {
  return StellarSdk.nativeToScVal(n, { type: "i128" });
}
function u32Val(n: number): StellarSdk.xdr.ScVal {
  return StellarSdk.nativeToScVal(n, { type: "u32" });
}
function bytesVal(hexStr: string): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvBytes(Buffer.from(hexStr, "hex"));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function invokeContract(
  signerKP:   StellarSdk.Keypair,
  contractId: string,
  method:     string,
  args:       StellarSdk.xdr.ScVal[]
): Promise<string> {
  const rpc      = new StellarSdk.rpc.Server(RPC_URL);
  const account  = await rpc.getAccount(signerKP.publicKey());
  const contract = new StellarSdk.Contract(contractId);

  let tx = new StellarSdk.TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: NET,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(180)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation error [${method}]: ${sim.error}`);
  }

  tx = StellarSdk.rpc.assembleTransaction(tx, sim).build();
  tx.sign(signerKP);

  const result = await rpc.sendTransaction(tx);
  if (result.status === "ERROR") {
    throw new Error(`Send error [${method}]: ${JSON.stringify(result.errorResult)}`);
  }

  // Poll for ledger confirmation (~5s per ledger)
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const status = await rpc.getTransaction(result.hash);
    if (status.status === "SUCCESS") return result.hash;
    if (status.status === "FAILED")  throw new Error(`Tx failed [${method}]: ${result.hash}`);
  }
  throw new Error(`Timeout waiting for tx [${method}]: ${result.hash}`);
}

/**
 * Runs the full 4-step AtomicSwap HTLC in background.
 * Updates swapStore at each step so the status endpoint can track progress.
 */
export async function executeAtomicSwapBackground(
  swapId:          string,
  initiatorSecret: string,
  counterpartySecret: string,
  contractA:       string,
  contractB:       string,
  sellAsset:       string,
  sellAmount:      number,
  buyAsset:        string,
  buyAmount:       number,
  initiatorLedgers:    number,
  counterpartyLedgers: number,
): Promise<void> {
  const update = (patch: Partial<SwapState>) => {
    const current = swapStore.get(swapId)!;
    swapStore.set(swapId, { ...current, ...patch, updated_at: new Date().toISOString() });
  };

  const initiatorKP    = StellarSdk.Keypair.fromSecret(initiatorSecret);
  const counterpartyKP = StellarSdk.Keypair.fromSecret(counterpartySecret);

  // Generate HTLC secret
  const secretBytes = crypto.randomBytes(32);
  const secret      = secretBytes.toString("hex");
  const secretHash  = crypto.createHash("sha256").update(secretBytes).digest("hex");
  const htlcSwapId  = crypto.createHash("sha256").update(Buffer.from(secretHash, "hex")).digest("hex");

  const sellToken = tokenSac(sellAsset);
  const buyToken  = tokenSac(buyAsset);
  const sellAmt   = BigInt(Math.round(sellAmount * 10_000_000));
  const buyAmt    = BigInt(Math.round(buyAmount  * 10_000_000));

  try {
    update({ status: "locking_a", secret_hash: secretHash });

    // Step 1 — Initiator locks sell_asset in Contract A
    const lockAHash = await invokeContract(initiatorKP, contractA, "lock", [
      addressVal(initiatorKP.publicKey()),
      addressVal(counterpartyKP.publicKey()),
      addressVal(sellToken),
      i128Val(sellAmt),
      bytesVal(secretHash),
      u32Val(initiatorLedgers),
    ]);
    update({ status: "locked_a", txs: { lock_a: lockAHash } });

    // Step 2 — Counterparty locks buy_asset in Contract B
    update({ status: "locking_b" });
    const lockBHash = await invokeContract(counterpartyKP, contractB, "lock", [
      addressVal(counterpartyKP.publicKey()),
      addressVal(initiatorKP.publicKey()),
      addressVal(buyToken),
      i128Val(buyAmt),
      bytesVal(secretHash),
      u32Val(counterpartyLedgers),
    ]);
    update({ status: "locked_b", txs: { ...swapStore.get(swapId)!.txs, lock_b: lockBHash } });

    // Step 3 — Initiator reveals secret on Contract B → gets buy_asset
    update({ status: "releasing_b" });
    const relBHash = await invokeContract(initiatorKP, contractB, "release", [
      bytesVal(htlcSwapId),
      bytesVal(secret),
    ]);
    update({ status: "released_b", txs: { ...swapStore.get(swapId)!.txs, release_b: relBHash } });

    // Step 4 — Counterparty uses public secret on Contract A → gets sell_asset
    update({ status: "releasing_a" });
    const relAHash = await invokeContract(counterpartyKP, contractA, "release", [
      bytesVal(htlcSwapId),
      bytesVal(secret),
    ]);
    update({ status: "completed", txs: { ...swapStore.get(swapId)!.txs, release_a: relAHash } });

  } catch (err) {
    update({ status: "failed", error: String(err) });
  }
}
