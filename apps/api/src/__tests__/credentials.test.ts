import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { credentialRoutes } from "../routes/credentials.js";

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
vi.mock("@stellar/stellar-sdk", async (importOriginal: () => Promise<typeof import("@stellar/stellar-sdk")>) => {
  const actual = await importOriginal();

  const fakeTx = { sign: vi.fn() };
  const fakeBuilder = {
    build: vi.fn().mockReturnValue(fakeTx),
  };

  return {
    ...actual,
    Networks: actual.Networks,
    xdr: actual.xdr,
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

const MOCK_PAYMENT_HEADER = "mock:GPAYER000000000000000000000000000000000000000000000000000:0.01";

describe("Credential Routes — WP 0.4 root governance", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.ZK_VERIFIER_CONTRACT_ID = "CA000000000000000000000000000000000000000000000000000000";
    process.env.ADMIN_SECRET_KEY = "SCZANGBA5AKIA4HF6DVRZ53VBZ7GVMQXMKKFZWQ5MEBOU2CTKXEJC4";
    process.env.X402_MOCK_MODE = "true";
    app = Fastify({ logger: false });
    await app.register(credentialRoutes);
    await app.ready();
  });

  beforeEach(() => {
    delete process.env.ALLOW_CLIENT_ROOTS;
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

  it("rejects a client-generated commitment/root (Mode A) by default", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/credentials/buy",
      headers: { "x-payment": MOCK_PAYMENT_HEADER },
      payload: { commitment: "123", merkle_root: "456" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/ALLOW_CLIENT_ROOTS/);
    // Must never reach setReputationRoot — no on-chain call attempted.
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("allows Mode A when ALLOW_CLIENT_ROOTS=true is explicitly set", async () => {
    process.env.ALLOW_CLIENT_ROOTS = "true";
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/credentials/buy",
      headers: { "x-payment": MOCK_PAYMENT_HEADER },
      payload: { commitment: "123", merkle_root: "456" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe("client_generated");
  });
});
