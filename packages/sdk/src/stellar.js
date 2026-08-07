import { Contract, Networks, rpc as SorobanRpc, TransactionBuilder, } from "@stellar/stellar-sdk";
const RPC_URLS = {
    testnet: "https://soroban-testnet.stellar.org",
    mainnet: "https://soroban-mainnet.stellar.org",
};
const NETWORK_PASSPHRASES = {
    testnet: Networks.TESTNET,
    mainnet: Networks.PUBLIC,
};
export function getRpcUrl(network) {
    return process.env.STELLAR_RPC_URL ?? RPC_URLS[network];
}
export function getNetworkPassphrase(network) {
    return NETWORK_PASSPHRASES[network];
}
export function createServer(network) {
    return new SorobanRpc.Server(getRpcUrl(network), { allowHttp: false });
}
/**
 * Build a Soroban contract call transaction.
 */
export async function buildContractTx(server, network, keypair, contractId, method, args) {
    const account = await server.getAccount(keypair.publicKey());
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(account, {
        fee: "100000",
        networkPassphrase: getNetworkPassphrase(network),
    })
        .addOperation(contract.call(method, ...args))
        .setTimeout(180)
        .build();
    const prepared = await server.prepareTransaction(tx);
    return prepared;
}
/**
 * Sign and submit a transaction, returning the tx hash.
 */
export async function signAndSubmit(server, tx, keypair) {
    tx.sign(keypair);
    const result = await server.sendTransaction(tx);
    if (result.status === "ERROR") {
        throw new Error(`Transaction failed: ${JSON.stringify(result)}`);
    }
    return result.hash;
}
/**
 * Wait for a transaction to be confirmed on-chain.
 * Polls every 2 seconds up to maxAttempts.
 */
export async function waitForConfirmation(server, txHash, maxAttempts = 20) {
    for (let i = 0; i < maxAttempts; i++) {
        const result = await server.getTransaction(txHash);
        if (result.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
            return result;
        }
        if (result.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
            throw new Error(`Transaction failed on-chain: ${txHash}`);
        }
        await sleep(2000);
    }
    throw new Error(`Transaction not confirmed after ${maxAttempts} attempts: ${txHash}`);
}
/**
 * Generate a 32-byte random secret and its SHA-256 hash.
 * Returns hex strings.
 */
export async function generateSecret() {
    const secretBytes = crypto.getRandomValues(new Uint8Array(32));
    const secret = Buffer.from(secretBytes).toString("hex");
    const hashBytes = await crypto.subtle.digest("SHA-256", secretBytes);
    const secretHash = Buffer.from(hashBytes).toString("hex");
    return { secret, secretHash };
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export function hexToBytes(hex) {
    return Buffer.from(hex, "hex");
}
//# sourceMappingURL=stellar.js.map