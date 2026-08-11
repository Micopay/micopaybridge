import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

// WP3: prove credentials.ts (unchanged) actually issues a spendable
// credential when the x402 payment came from Base, not just Stellar/mock —
// i.e. the ZK gate is genuinely chain-agnostic, not just "should be" by
// reading the code. Same module-const-vs-import-order issue as
// x402-base.test.ts: set env vars, THEN dynamically import.

const mockVerifyTypedData = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockWriteContract = vi.hoisted(() => vi.fn().mockResolvedValue("0x" + "cd".repeat(32)));
const mockWaitForTransactionReceipt = vi.hoisted(() => vi.fn().mockResolvedValue({ status: "success" }));

vi.mock("viem", async (importOriginal: () => Promise<typeof import("viem")>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    verifyTypedData: mockVerifyTypedData,
    createWalletClient: () => ({ writeContract: mockWriteContract }),
    createPublicClient: () => ({ waitForTransactionReceipt: mockWaitForTransactionReceipt }),
  };
});

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: () => ({ address: "0x1111111111111111111111111111111111111a" }),
}));

// zkVerify.ts talks to Soroban RPC for fetchReputationRoot/setReputationRoot —
// stub it so this test only exercises the x402/credential-issuance wiring,
// not live Stellar network calls (same boundary credentials.test.ts assumes
// implicitly via X402_MOCK_MODE for payment, but this also needs the ZK side
// stubbed since we're not mocking @stellar/stellar-sdk here).
const mockFetchReputationRoot = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockSetReputationRoot = vi.hoisted(() => vi.fn().mockResolvedValue("stellar-tx-hash"));
vi.mock("../lib/zkVerify.js", () => ({
  fetchReputationRoot: mockFetchReputationRoot,
  setReputationRoot: mockSetReputationRoot,
}));

const PLATFORM_BASE = "0x00000000000000000000000000000000000aaa";
const AGENT_FROM = "0x00000000000000000000000000000000000bbb";

// Unique per test-file run — see x402-base.test.ts for why (a real reachable
// Postgres persists replay keys across runs; hardcoded nonces would collide
// with a previous run's leftover rows).
const RUN_ID = Math.random().toString(16).slice(2).padEnd(8, "0").slice(0, 8);
function uniqueNonce(seedByte: string): string {
  return "0x" + seedByte.repeat(28) + RUN_ID;
}

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

function basePaymentHeader(nonce: string): string {
  const now = Math.floor(Date.now() / 1000);
  return b64({
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: "0x" + "11".repeat(65),
      authorization: {
        from: AGENT_FROM,
        to: PLATFORM_BASE,
        value: "10000", // 0.01 USDC @ 6 decimals — credential_buy's price
        validAfter: String(now - 60),
        validBefore: String(now + 300),
        nonce,
      },
    },
  });
}

describe("Credential purchase paid from Base (WP3)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.X402_ACCEPT_CHAINS = "stellar,base";
    process.env.PLATFORM_BASE_ADDRESS = PLATFORM_BASE;
    process.env.BASE_CHAIN_ID = "84532";
    process.env.BASE_USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    process.env.RELAYER_EVM_PRIVATE_KEY = "0x" + "11".repeat(32);
    delete process.env.X402_FACILITATOR_URL;

    const [{ requirePayment }, { credentialRoutes }] = await Promise.all([
      import("../middleware/x402.js"),
      import("../routes/credentials.js"),
    ]);
    void requirePayment; // credentialRoutes wires its own requirePayment internally

    app = Fastify();
    await app.register(credentialRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("issues a spendable pool credential when paid via Base x402", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/credentials/buy",
      headers: { "x-payment": basePaymentHeader(uniqueNonce("78")) },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // The payer recorded on the credential purchase is the Base 0x address,
    // not a Stellar G... address — proves payerAddress really is chain-agnostic.
    expect(body.payer).toBe(AGENT_FROM);

    // Same credential shape /inference expects regardless of who paid or how.
    expect(body.credential).toBeDefined();
    expect(body.credential.circuit_id).toBe("access_credential_v1");
    expect(Array.isArray(body.credential.public_inputs)).toBe(true);
    expect(body.credential.public_inputs).toHaveLength(2); // [merkle_root, nullifier]
    expect(typeof body.credential.secret).toBe("string");
  });

  it("rejects the purchase if the Base payment doesn't verify (no free credentials)", async () => {
    mockVerifyTypedData.mockResolvedValueOnce(false);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/credentials/buy",
      headers: { "x-payment": basePaymentHeader(uniqueNonce("9a")) },
      payload: {},
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().credential).toBeUndefined();
  });
});
