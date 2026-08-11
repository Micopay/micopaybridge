import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { zkRoutes } from "../routes/zk.js";

// Shared mock functions — defined with vi.hoisted() so they're accessible inside vi.mock()
// (vi.mock() factories are hoisted before imports, so outer-scope let/const aren't ready yet).
const mockGetAccount = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ accountId: () => "GTEST", incrementSequenceNumber: vi.fn() })
);
const mockSimulateTransaction = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ result: null })
);
const mockSendTransaction = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ status: "PENDING", hash: "aabbcc" })
);
const mockGetTransaction = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ status: "SUCCESS", returnValue: null })
);

// Stub all Soroban/network calls so tests run offline.
// The Server class uses the shared hoisted mocks so per-test overrides work.
vi.mock("@stellar/stellar-sdk", async (importOriginal: () => Promise<typeof import("@stellar/stellar-sdk")>) => {
  const actual = await importOriginal();

  const fakeTx = { sign: vi.fn() };
  const fakeBuilder = {
    build: vi.fn().mockReturnValue(fakeTx),
  };

  return {
    ...actual,
    Networks: actual.Networks,
    nativeToScVal: actual.nativeToScVal,
    xdr: actual.xdr,
    Address: actual.Address,
    Keypair: {
      fromSecret: vi.fn().mockReturnValue({
        publicKey: () => "GBTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    },
    Contract: class {
      call = vi.fn().mockReturnValue({});
    },
    TransactionBuilder: class {
      addOperation = vi.fn().mockReturnThis();
      setTimeout = vi.fn().mockReturnThis();
      build = vi.fn().mockReturnValue(fakeTx);
    },
    rpc: {
      ...actual.rpc,
      assembleTransaction: vi.fn().mockReturnValue(fakeBuilder),
      // Each new Server() instance delegates to the shared hoisted mock fns,
      // so tests can use mockResolvedValueOnce / mockRejectedValueOnce directly.
      Server: class {
        getAccount = mockGetAccount;
        simulateTransaction = mockSimulateTransaction;
        sendTransaction = mockSendTransaction;
        getTransaction = mockGetTransaction;
      },
      Api: {
        ...actual.rpc?.Api,
        isSimulationError: () => false,
      },
    },
  };
});

const MOCK_PAYMENT_HEADER = "mock:GPAYER000000000000000000000000000000000000000000000000000:0.001";
const VALID_PROOF_B64 = Buffer.alloc(64).toString("base64");

describe("ZK Routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.ZK_VERIFIER_CONTRACT_ID = "CA000000000000000000000000000000000000000000000000000000";
    process.env.ADMIN_SECRET_KEY = "SCZANGBA5AKIA4HF6DVRZ53VBZ7GVMQXMKKFZWQ5MEBOU2CTKXEJC4";
    // SEC-C2: the mock payment bypass now requires an explicit opt-in outside
    // production — these tests exercise MOCK_PAYMENT_HEADER, so opt in here.
    process.env.X402_MOCK_MODE = "true";
    app = Fastify({ logger: false });
    await app.register(zkRoutes);
    await app.ready();
  });

  beforeEach(() => {
    // Reset shared mocks to safe defaults before each test to avoid state leakage.
    mockGetAccount.mockReset();
    mockGetAccount.mockResolvedValue({ accountId: () => "GTEST", incrementSequenceNumber: vi.fn() });
    mockSimulateTransaction.mockReset();
    mockSimulateTransaction.mockResolvedValue({ result: null });
    mockSendTransaction.mockReset();
    mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "aabbcc" });
    mockGetTransaction.mockReset();
    mockGetTransaction.mockResolvedValue({ status: "SUCCESS", returnValue: null });
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /api/v1/zk/circuits", () => {
    it("returns circuit list without payment", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/zk/circuits" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.circuits).toHaveLength(3);
      const ids = body.circuits.map((c: { circuit_id: string }) => c.circuit_id);
      expect(ids).toContain("poseidon_preimage");
      expect(ids).toContain("reputation_v1");
      expect(ids).toContain("access_credential_v1");
    });

    it("includes payment info", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/zk/circuits" });
      const body = JSON.parse(res.body);
      expect(body.payment.amount_usdc).toBe("0.001");
    });
  });

  describe("POST /api/v1/zk/verify", () => {
    it("returns 402 without payment header", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/zk/verify",
        payload: { circuit_id: "poseidon_preimage", proof: VALID_PROOF_B64, public_inputs: ["1234"] },
      });
      expect(res.statusCode).toBe(402);
    });

    it("returns 400 for unknown circuit_id", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/zk/verify",
        headers: { "x-payment": MOCK_PAYMENT_HEADER },
        payload: { circuit_id: "unknown_circuit", proof: VALID_PROOF_B64, public_inputs: ["1"] },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/Unknown circuit_id/);
    });

    it("returns 400 for wrong number of public_inputs (poseidon_preimage needs 1)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/zk/verify",
        headers: { "x-payment": MOCK_PAYMENT_HEADER },
        payload: {
          circuit_id: "poseidon_preimage",
          proof: VALID_PROOF_B64,
          public_inputs: ["1", "2"], // too many
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/exactly 1/);
    });

    it("returns 400 for wrong number of public_inputs (reputation_v1 needs 4)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/zk/verify",
        headers: { "x-payment": MOCK_PAYMENT_HEADER },
        payload: {
          circuit_id: "reputation_v1",
          proof: VALID_PROOF_B64,
          public_inputs: ["1", "2"], // too few
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/exactly 4/);
    });

    it("returns 400 for non-decimal public_input", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/zk/verify",
        headers: { "x-payment": MOCK_PAYMENT_HEADER },
        payload: {
          circuit_id: "poseidon_preimage",
          proof: VALID_PROOF_B64,
          public_inputs: ["0xdeadbeef"], // hex not allowed
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/decimal/);
    });

    it("returns 400 for empty proof", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/zk/verify",
        headers: { "x-payment": MOCK_PAYMENT_HEADER },
        payload: {
          circuit_id: "poseidon_preimage",
          proof: "", // empty string → zero-length buffer → rejected
          public_inputs: ["1234"],
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns verified result for poseidon_preimage with mock payment", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/zk/verify",
        headers: { "x-payment": MOCK_PAYMENT_HEADER },
        payload: {
          circuit_id: "poseidon_preimage",
          proof: VALID_PROOF_B64,
          public_inputs: ["9876543210123456789"],
        },
      });
      if (res.statusCode !== 200) console.error("ZK 502 detail:", res.body);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(typeof body.verified).toBe("boolean");
      expect(body.circuit_id).toBe("poseidon_preimage");
    });

    it("returns verified result for reputation_v1 with 4 inputs and mock payment", async () => {
      // The root check now fails closed on a null return (SEC-C4), so this
      // test must mock a genuine matching on-chain root instead of relying
      // on the old (vulnerable) "null root -> check skipped" behavior.
      const StellarModule = await import("@stellar/stellar-sdk");
      const onChainRootDec = "111111111111111111111111";
      const onChainRootHex = BigInt(onChainRootDec).toString(16).padStart(64, "0");
      const onChainRootBuf = Buffer.from(onChainRootHex, "hex");
      mockSimulateTransaction.mockResolvedValueOnce({
        result: { retval: StellarModule.xdr.ScVal.scvBytes(onChainRootBuf) },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/zk/verify",
        headers: { "x-payment": MOCK_PAYMENT_HEADER },
        payload: {
          circuit_id: "reputation_v1",
          proof: VALID_PROOF_B64,
          public_inputs: [
            onChainRootDec,
            "2",
            "333333333333333333333333",
            "444444444444444444444444",
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(typeof body.verified).toBe("boolean");
      expect(body.circuit_id).toBe("reputation_v1");
    });

    it("returns 503 for reputation_v1 when on-chain root fetch returns null without throwing (SEC-C4)", async () => {
      // Default mock: simulateTransaction resolves { result: null } — no
      // exception, just an empty/unreadable result. Must fail closed too.
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/zk/verify",
        headers: { "x-payment": MOCK_PAYMENT_HEADER },
        payload: {
          circuit_id: "reputation_v1",
          proof: VALID_PROOF_B64,
          public_inputs: [
            "111111111111111111111111",
            "2",
            "333333333333333333333333",
            "444444444444444444444444",
          ],
        },
      });
      expect(res.statusCode).toBe(503);
    });

    it("returns 400 when reputation_v1 merkle_root does not match on-chain root", async () => {
      // Make fetchReputationRoot() return a concrete on-chain root by having
      // simulateTransaction return a scvBytes ScVal on the first call.
      const StellarModule = await import("@stellar/stellar-sdk");

      const onChainRootDec = "99999999999999999999999999999";
      const onChainRootHex = BigInt(onChainRootDec).toString(16).padStart(64, "0");
      const onChainRootBuf = Buffer.from(onChainRootHex, "hex");

      // First call: fetchReputationRoot → return the on-chain root
      mockSimulateTransaction.mockResolvedValueOnce({
        result: { retval: StellarModule.xdr.ScVal.scvBytes(onChainRootBuf) },
      });
      // Subsequent calls (invokeVerify) use the default { result: null }

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/zk/verify",
        headers: { "x-payment": MOCK_PAYMENT_HEADER },
        payload: {
          circuit_id: "reputation_v1",
          proof: VALID_PROOF_B64,
          public_inputs: [
            "12345", // stale/wrong root — does not match onChainRootDec
            "2",
            "333333333333333333333333",
            "444444444444444444444444",
          ],
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/merkle_root/);
    });

    // SEC-08 — Fatal Merkle root guard: RPC failure must reject with 503, not silently pass through.
    // Before the fix the catch block was non-fatal and a fabricated root could bypass the check
    // during an RPC outage window.
    it("returns 503 for reputation_v1 when RPC is unreachable (SEC-08 fatal guard)", async () => {
      mockGetAccount.mockRejectedValueOnce(new Error("ECONNREFUSED: RPC endpoint unreachable"));

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/zk/verify",
        headers: { "x-payment": MOCK_PAYMENT_HEADER },
        payload: {
          circuit_id: "reputation_v1",
          proof: VALID_PROOF_B64,
          public_inputs: [
            "99999999999999999999999", // fabricated root — would bypass check if non-fatal
            "2",
            "333333333333333333333333",
            "444444444444444444444444",
          ],
        },
      });

      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/Merkle root/);
    });

    it("returns 503 for access_credential_v1 when RPC is unreachable (SEC-08 fatal guard)", async () => {
      mockGetAccount.mockRejectedValueOnce(new Error("Request timeout"));

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/zk/verify",
        headers: { "x-payment": MOCK_PAYMENT_HEADER },
        payload: {
          circuit_id: "access_credential_v1",
          proof: VALID_PROOF_B64,
          public_inputs: [
            "99999999999999999999999", // fabricated root
            "444444444444444444444444",
          ],
        },
      });

      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/Merkle root/);
    });

    it("poseidon_preimage is unaffected by RPC failure (no Merkle root check)", async () => {
      // poseidon_preimage is NOT in ROOTED_CIRCUITS, so fetchReputationRoot is never
      // called. Even if the RPC were down for the root fetch, the circuit should succeed.
      // (In this test the mocks are healthy, verifying that no extraneous root fetch occurs.)
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/zk/verify",
        headers: { "x-payment": MOCK_PAYMENT_HEADER },
        payload: {
          circuit_id: "poseidon_preimage",
          proof: VALID_PROOF_B64,
          public_inputs: ["9876543210123456789"],
        },
      });

      expect(res.statusCode).toBe(200);
    });

    // Replay attack: same proof submitted twice → second must be rejected (409).
    // Requires ZkVerifierRegistry.verify_unique deployed on-chain (WP4 redeploy).
    // Skipped until the redeployed contract is live; the 409 mapping in zk.ts is ready.
    it.skip("returns 409 on replay — same reputation_v1 proof submitted twice (requires WP4 redeploy)", async () => {
      // After WP4 redeploy: the contract's verify_unique returns Error(Contract, #10)
      // on the second call with the same nullifier. The API maps this to HTTP 409.
      // To activate: remove .skip, redeploy ZkVerifierRegistry, update ZK_VERIFIER_CONTRACT_ID.
      const payload = {
        circuit_id: "reputation_v1",
        proof: VALID_PROOF_B64,
        public_inputs: [
          "111111111111111111111111",
          "2",
          "333333333333333333333333",
          "444444444444444444444444",
        ],
      };

      const first = await app.inject({
        method: "POST", url: "/api/v1/zk/verify",
        headers: { "x-payment": MOCK_PAYMENT_HEADER },
        payload,
      });
      expect(first.statusCode).toBe(200);

      // Second submission — contract rejects; getTransaction returns FAILED
      // with error detail "Error(Contract, #10)" in the result XDR
      mockGetTransaction.mockResolvedValueOnce({
        status: "FAILED",
        resultMetaXdr: "Error(Contract, #10)",
      });

      const second = await app.inject({
        method: "POST", url: "/api/v1/zk/verify",
        headers: { "x-payment": MOCK_PAYMENT_HEADER },
        payload,
      });

      expect(second.statusCode).toBe(409);
      expect(JSON.parse(second.body).error).toMatch(/Nullifier already used/);
    });
  });
});
