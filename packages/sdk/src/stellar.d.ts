import { Keypair, rpc as SorobanRpc, Transaction, xdr } from "@stellar/stellar-sdk";
export type Network = "testnet" | "mainnet";
export declare function getRpcUrl(network: Network): string;
export declare function getNetworkPassphrase(network: Network): string;
export declare function createServer(network: Network): SorobanRpc.Server;
/**
 * Build a Soroban contract call transaction.
 */
export declare function buildContractTx(server: SorobanRpc.Server, network: Network, keypair: Keypair, contractId: string, method: string, args: xdr.ScVal[]): Promise<Transaction>;
/**
 * Sign and submit a transaction, returning the tx hash.
 */
export declare function signAndSubmit(server: SorobanRpc.Server, tx: Transaction, keypair: Keypair): Promise<string>;
/**
 * Wait for a transaction to be confirmed on-chain.
 * Polls every 2 seconds up to maxAttempts.
 */
export declare function waitForConfirmation(server: SorobanRpc.Server, txHash: string, maxAttempts?: number): Promise<SorobanRpc.Api.GetTransactionResponse>;
/**
 * Generate a 32-byte random secret and its SHA-256 hash.
 * Returns hex strings.
 */
export declare function generateSecret(): Promise<{
    secret: string;
    secretHash: string;
}>;
export declare function sleep(ms: number): Promise<void>;
export declare function hexToBytes(hex: string): Buffer;
//# sourceMappingURL=stellar.d.ts.map