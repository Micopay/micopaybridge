import { Keypair, rpc as SorobanRpc, xdr, nativeToScVal, scValToNative, } from "@stellar/stellar-sdk";
import { buildContractTx, signAndSubmit, waitForConfirmation, } from "./stellar.js";
/**
 * AtomicSwapClient — TypeScript wrapper for the AtomicSwapHTLC Soroban contract.
 * Purely deterministic — no LLM calls.
 */
export class AtomicSwapClient {
    server;
    network;
    contractId;
    constructor(contractId, network = "testnet") {
        this.contractId = contractId;
        this.network = network;
        this.server = new SorobanRpc.Server(process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org", { allowHttp: false });
    }
    /**
     * Lock funds. Returns swap_id (hex string).
     */
    async lock(params, keypair) {
        const args = [
            nativeToScVal(params.initiator, { type: "address" }),
            nativeToScVal(params.counterparty, { type: "address" }),
            nativeToScVal(params.token, { type: "address" }),
            nativeToScVal(params.amount, { type: "i128" }),
            xdr.ScVal.scvBytes(Buffer.from(params.secretHash, "hex")),
            nativeToScVal(params.timeoutLedgers, { type: "u32" }),
        ];
        const tx = await buildContractTx(this.server, this.network, keypair, this.contractId, "lock", args);
        const hash = await signAndSubmit(this.server, tx, keypair);
        const result = await waitForConfirmation(this.server, hash);
        // returnValue exists on GetSuccessfulTransactionResponse
        const successResult = result;
        const returnVal = successResult.returnValue;
        if (!returnVal)
            return hash; // fallback to tx hash
        const swapIdBytes = scValToNative(returnVal);
        return Buffer.isBuffer(swapIdBytes)
            ? swapIdBytes.toString("hex")
            : hash;
    }
    /**
     * Release funds by revealing the secret.
     */
    async release(swapId, secret, keypair) {
        const args = [
            xdr.ScVal.scvBytes(Buffer.from(swapId, "hex")),
            xdr.ScVal.scvBytes(Buffer.from(secret, "hex")),
        ];
        const tx = await buildContractTx(this.server, this.network, keypair, this.contractId, "release", args);
        const hash = await signAndSubmit(this.server, tx, keypair);
        await waitForConfirmation(this.server, hash);
        return hash;
    }
    /**
     * Refund initiator after timeout.
     */
    async refund(swapId, keypair) {
        const args = [xdr.ScVal.scvBytes(Buffer.from(swapId, "hex"))];
        const tx = await buildContractTx(this.server, this.network, keypair, this.contractId, "refund", args);
        const hash = await signAndSubmit(this.server, tx, keypair);
        await waitForConfirmation(this.server, hash);
        return hash;
    }
    /**
     * Get swap status (simulation — no fee).
     */
    async getStatus(swapId) {
        const args = [xdr.ScVal.scvBytes(Buffer.from(swapId, "hex"))];
        const dummyKeypair = Keypair.random();
        const tx = await buildContractTx(this.server, this.network, dummyKeypair, this.contractId, "get_status", args);
        const result = await this.server.simulateTransaction(tx);
        if (SorobanRpc.Api.isSimulationError(result)) {
            throw new Error(`Simulation failed: ${result.error}`);
        }
        const returnVal = result
            .result?.retval;
        if (!returnVal)
            throw new Error("No return value from get_status()");
        const raw = scValToNative(returnVal);
        return raw.toLowerCase();
    }
}
//# sourceMappingURL=swap-client.js.map