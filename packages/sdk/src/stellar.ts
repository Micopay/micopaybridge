import {
  Contract,
  Keypair,
  Networks,
  rpc as SorobanRpc,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

export type Network = "testnet" | "mainnet";

const RPC_URLS: Record<Network, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://soroban-mainnet.stellar.org",
};

const NETWORK_PASSPHRASES: Record<Network, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

export function getRpcUrl(network: Network): string {
  return process.env.STELLAR_RPC_URL ?? RPC_URLS[network];
}

export function getNetworkPassphrase(network: Network): string {
  return NETWORK_PASSPHRASES[network];
}

export function createServer(network: Network): SorobanRpc.Server {
  return new SorobanRpc.Server(getRpcUrl(network), { allowHttp: false });
}

/**
 * Build a Soroban contract call transaction.
 */
export async function buildContractTx(
  server: SorobanRpc.Server,
  network: Network,
  keypair: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[]
): Promise<Transaction> {
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
  return prepared as Transaction;
}

/**
 * Sign and submit a transaction, returning the tx hash.
 */
export async function signAndSubmit(
  server: SorobanRpc.Server,
  tx: Transaction,
  keypair: Keypair
): Promise<string> {
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
export async function waitForConfirmation(
  server: SorobanRpc.Server,
  txHash: string,
  maxAttempts = 20
): Promise<SorobanRpc.Api.GetTransactionResponse> {
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
export async function generateSecret(): Promise<{ secret: string; secretHash: string }> {
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = Buffer.from(secretBytes).toString("hex");
  const hashBytes = await crypto.subtle.digest("SHA-256", secretBytes);
  const secretHash = Buffer.from(hashBytes).toString("hex");
  return { secret, secretHash };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}
