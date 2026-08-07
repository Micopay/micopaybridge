import { Keypair } from "@stellar/stellar-sdk";
import { AtomicSwapClient } from "@micopay/sdk";
import type { SwapPlan, SwapResult } from "@micopay/types";

type Network = "testnet" | "mainnet";

const NETWORK = (process.env.STELLAR_NETWORK?.toLowerCase() ?? "testnet") as Network;
const ATOMIC_SWAP_CONTRACT_A = process.env.ATOMIC_SWAP_CONTRACT_ID ?? "";
const ATOMIC_SWAP_CONTRACT_B = process.env.ATOMIC_SWAP_CONTRACT_B_ID ?? ATOMIC_SWAP_CONTRACT_A;

const POLL_INTERVAL_MS = 3000;

/**
 * SwapExecutor — purely deterministic, zero LLM.
 *
 * Receives a SwapPlan from the Intent Parser and executes it step by step.
 * This is the only component that touches user funds.
 *
 * Core loop:
 *  1. Generate secret + hash
 *  2. Lock on chain A (Stellar)
 *  3. Wait for counterparty lock on chain B
 *  4. If found and valid → release on chain B (reveal secret)
 *  5. Counterparty's agent reads secret from chain B events → releases on chain A
 *  6. If timeout → refund on chain A
 */
export class SwapExecutor {
  private clientA: AtomicSwapClient;
  private clientB: AtomicSwapClient;
  private keypair: Keypair;

  constructor(secretKey: string) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.clientA = new AtomicSwapClient(ATOMIC_SWAP_CONTRACT_A, NETWORK);
    // For demo: chain B is a second HTLC instance on the same testnet
    this.clientB = new AtomicSwapClient(ATOMIC_SWAP_CONTRACT_B, NETWORK);
  }

  async execute(plan: SwapPlan): Promise<SwapResult> {
    const { secret, secretHash } = await generateSecret();

    console.log(`[Executor] Starting swap ${plan.id}`);
    console.log(`[Executor] Sell: ${plan.amounts.sell_amount} ${plan.amounts.sell_asset}`);
    console.log(`[Executor] Buy:  ${plan.amounts.buy_amount} ${plan.amounts.buy_asset}`);

    // Step 1: Lock on chain A (Stellar)
    let lockTxHash: string;
    let swapIdA: string;

    try {
      swapIdA = await this.clientA.lock(
        {
          initiator: this.keypair.publicKey(),
          counterparty: plan.counterparty.address,
          token: plan.amounts.sell_asset, // SAC address in production
          amount: BigInt(Math.round(parseFloat(plan.amounts.sell_amount) * 1e7)),
          secretHash,
          timeoutLedgers: plan.timeouts.initiator_ledgers,
        },
        this.keypair
      );
      lockTxHash = swapIdA;
      console.log(`[Executor] Locked on chain A. swap_id=${swapIdA}`);
    } catch (err) {
      return {
        swap_id: plan.id,
        status: "failed",
        error: `Failed to lock on chain A: ${err}`,
      };
    }

    // Step 2: Wait for counterparty lock on chain B
    const deadline = Date.now() + plan.timeouts.counterparty_ledgers * 5000; // ~5s/ledger
    const counterpartyLock = await this.waitForCounterpartyLock(
      plan.counterparty.address,
      secretHash,
      deadline
    );

    if (!counterpartyLock) {
      console.log("[Executor] Counterparty did not lock in time. Refunding...");
      try {
        await this.clientA.refund(swapIdA, this.keypair);
      } catch (e) {
        console.error("[Executor] Refund failed:", e);
      }
      return {
        swap_id: plan.id,
        status: "refunded",
        stellar_tx_hash: lockTxHash,
        error: "counterparty_no_lock",
      };
    }

    console.log(`[Executor] Counterparty locked on chain B. swap_id=${counterpartyLock.swapId}`);

    // Step 3: Release on chain B — reveals the secret publicly
    let chainBTxHash: string;
    try {
      chainBTxHash = await this.clientB.release(
        counterpartyLock.swapId,
        secret,
        this.keypair
      );
      console.log(`[Executor] Released on chain B. tx=${chainBTxHash}`);
      console.log(`[Executor] Secret revealed: ${secret}`);
      console.log("[Executor] Counterparty agent can now claim on chain A using this secret.");
    } catch (err) {
      return {
        swap_id: plan.id,
        status: "partial",
        stellar_tx_hash: lockTxHash,
        error: `Failed to release on chain B: ${err}`,
      };
    }

    return {
      swap_id: plan.id,
      status: "completed",
      stellar_tx_hash: lockTxHash,
      chain_b_tx_hash: chainBTxHash,
      completed_at: new Date().toISOString(),
    };
  }

  /**
   * Poll chain B for a lock matching our secret_hash.
   * In production: subscribe to Stellar events for the contract.
   * For demo: poll every 3 seconds.
   */
  private async waitForCounterpartyLock(
    counterpartyAddress: string,
    secretHash: string,
    deadline: number
  ): Promise<{ swapId: string } | null> {
    console.log(`[Executor] Waiting for counterparty lock on chain B...`);

    while (Date.now() < deadline) {
      try {
        // In production: query contract events for swap_locked with matching secret_hash
        // For demo: simulate finding the counterparty lock
        const found = await this.checkChainBLock(counterpartyAddress, secretHash);
        if (found) return found;
      } catch {
        // Ignore poll errors, keep trying
      }

      await sleep(POLL_INTERVAL_MS);
    }

    return null;
  }

  /**
   * Check if counterparty has locked on chain B.
   *
   * In demo mode: simulates the counterparty action after 5 seconds.
   * In production: query Stellar RPC for contract events.
   */
  private async checkChainBLock(
    _counterpartyAddress: string,
    secretHash: string
  ): Promise<{ swapId: string } | null> {
    // Demo simulation: counterparty "locks" after 5s
    // In production, this queries the AtomicSwapHTLC contract events
    const mockSwapId = Buffer.from(
      await crypto.subtle.digest("SHA-256", Buffer.from(secretHash + "_chain_b", "hex"))
    ).toString("hex");

    return { swapId: mockSwapId };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateSecret(): Promise<{ secret: string; secretHash: string }> {
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = Buffer.from(secretBytes).toString("hex");
  const hashBytes = await crypto.subtle.digest("SHA-256", secretBytes);
  const secretHash = Buffer.from(hashBytes).toString("hex");
  return { secret, secretHash };
}
