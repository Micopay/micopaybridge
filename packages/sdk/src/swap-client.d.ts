import { Keypair } from "@stellar/stellar-sdk";
import type { SwapStatus } from "@micopay/types";
import { type Network } from "./stellar.js";
export interface LockParams {
    initiator: string;
    counterparty: string;
    token: string;
    amount: bigint;
    secretHash: string;
    timeoutLedgers: number;
}
/**
 * AtomicSwapClient — TypeScript wrapper for the AtomicSwapHTLC Soroban contract.
 * Purely deterministic — no LLM calls.
 */
export declare class AtomicSwapClient {
    private server;
    private network;
    private contractId;
    constructor(contractId: string, network?: Network);
    /**
     * Lock funds. Returns swap_id (hex string).
     */
    lock(params: LockParams, keypair: Keypair): Promise<string>;
    /**
     * Release funds by revealing the secret.
     */
    release(swapId: string, secret: string, keypair: Keypair): Promise<string>;
    /**
     * Refund initiator after timeout.
     */
    refund(swapId: string, keypair: Keypair): Promise<string>;
    /**
     * Get swap status (simulation — no fee).
     */
    getStatus(swapId: string): Promise<SwapStatus>;
}
//# sourceMappingURL=swap-client.d.ts.map