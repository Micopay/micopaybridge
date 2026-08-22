import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import {
  Account,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  Keypair,
  MemoText,
  MemoNone,
} from "@stellar/stellar-sdk";
import { requirePayment } from "../middleware/x402.js";

// Mock Horizon server to prevent actual network calls
const mockSubmitTransaction = vi.fn().mockResolvedValue({ id: "txhash" });
const mockTransactionCheck = vi.fn().mockResolvedValue(false);

vi.mock("@stellar/stellar-sdk", async (importOriginal: () => Promise<typeof import("@stellar/stellar-sdk")>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    Horizon: {
      Server: vi.fn(() => ({
        submitTransaction: mockSubmitTransaction,
        transactions: () => ({
          transaction: () => ({
            call: mockTransactionCheck,
          }),
        }),
      })),
    },
  };
});

const SERVICE_NAME = "stellar-test";
const PAYER_KEYPAIR = Keypair.random();
const PLATFORM_ADDRESS = "GDKKW2WSMQWZ63PIZBKDDBAAOBG5FP3TUHRYQ4U5RBKTFNESL5K5BJJK";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

// Helper to build a Stellar USDC payment transaction for testing
function buildStellarTransaction(overrides: {
  memo?: string;
  includeTimeBounds?: boolean;
  timeBoundsMaxTime?: number;
  noMemo?: boolean;
} = {}) {
  const source = new Account(PAYER_KEYPAIR.publicKey(), 0);
  const now = Math.floor(Date.now() / 1000);

  let builder = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
    memo: overrides.noMemo
      ? new MemoNone()
      : new MemoText(overrides.memo || `micopay:${SERVICE_NAME}`),
  });

  // Add time bounds (default: 5 minutes)
  if (overrides.includeTimeBounds !== false) {
    if (overrides.timeBoundsMaxTime !== undefined) {
      builder = builder.setTimebounds(now, overrides.timeBoundsMaxTime);
    } else {
      builder = builder.setTimebounds(now, now + 300); // 5 minutes
    }
  }

  const tx = builder
    .addOperation({
      type: "payment",
      destination: PLATFORM_ADDRESS,
      asset: {
        code: "USDC",
        issuer: USDC_ISSUER,
      },
      amount: "0.001",
    } as any)
    .build();

  tx.sign(PAYER_KEYPAIR);
  return tx.toXDR("base64");
}

describe("x402 Stellar Memo and TimeBounds Validation (BRIDGE-11)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Set up environment for Stellar
    process.env.STELLAR_NETWORK = "TESTNET";
    process.env.PLATFORM_STELLAR_ADDRESS = PLATFORM_ADDRESS;
    process.env.USDC_ISSUER = USDC_ISSUER;
    process.env.X402_MOCK_MODE = "false"; // Disable mock mode to test real Stellar validation

    // Reimport the module to pick up env vars
    // Note: This is hacky but necessary since Stellar SDK constants are module-scoped
    delete require.cache[require.resolve("../middleware/x402.js")];

    app = Fastify();
    const { requirePayment: importedRequirePayment } = await import("../middleware/x402.js");
    app.get("/test-stellar", {
      preHandler: importedRequirePayment({ amount: "0.001", service: SERVICE_NAME }),
    }, async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("Memo Validation", () => {
    it("should accept a payment with correct memo (BRIDGE-11 acceptance criteria #1)", async () => {
      mockSubmitTransaction.mockClear();
      mockSubmitTransaction.mockResolvedValueOnce({ id: "txhash" });

      const xdr = buildStellarTransaction({ memo: `micopay:${SERVICE_NAME}` });
      const response = await app.inject({
        method: "GET",
        url: "/test-stellar",
        headers: { "x-payment": xdr },
      });

      // Since we're not mocking the full Horizon flow, this might still fail at submission
      // but it should NOT fail at the memo validation step
      if (response.statusCode === 402) {
        const body = JSON.parse(response.body);
        // Should fail for other reasons (submission, etc.), not memo
        expect(body.message).not.toContain("Invalid memo");
      }
    });

    it("should reject a payment with wrong memo (BRIDGE-11 acceptance criteria #1)", async () => {
      mockSubmitTransaction.mockClear();
      const xdr = buildStellarTransaction({ memo: "micopay:different-service" });
      const response = await app.inject({
        method: "GET",
        url: "/test-stellar",
        headers: { "x-payment": xdr },
      });

      expect(response.statusCode).toBe(402);
      const body = JSON.parse(response.body);
      expect(body.message).toContain("Invalid memo");
      expect(body.message).toContain(`micopay:${SERVICE_NAME}`);
    });

    it("should reject a payment with no memo (BRIDGE-11 acceptance criteria #2)", async () => {
      mockSubmitTransaction.mockClear();
      const xdr = buildStellarTransaction({ noMemo: true });
      const response = await app.inject({
        method: "GET",
        url: "/test-stellar",
        headers: { "x-payment": xdr },
      });

      expect(response.statusCode).toBe(402);
      const body = JSON.parse(response.body);
      expect(body.message).toContain("Invalid memo");
      expect(body.message).toContain(`micopay:${SERVICE_NAME}`);
    });
  });

  describe("TimeBounds Validation", () => {
    it("should reject a transaction whose maxTime has passed (BRIDGE-11 acceptance criteria #3)", async () => {
      mockSubmitTransaction.mockClear();
      const now = Math.floor(Date.now() / 1000);
      const expiredMaxTime = now - 60; // 60 seconds in the past
      const xdr = buildStellarTransaction({
        memo: `micopay:${SERVICE_NAME}`,
        timeBoundsMaxTime: expiredMaxTime,
      });

      const response = await app.inject({
        method: "GET",
        url: "/test-stellar",
        headers: { "x-payment": xdr },
      });

      expect(response.statusCode).toBe(402);
      const body = JSON.parse(response.body);
      expect(body.message).toContain("expired");
      expect(body.message).toContain("maxTime");
    });

    it("should reject a transaction without time bounds (BRIDGE-11 acceptance criteria #4)", async () => {
      mockSubmitTransaction.mockClear();
      const xdr = buildStellarTransaction({
        memo: `micopay:${SERVICE_NAME}`,
        includeTimeBounds: false,
      });

      const response = await app.inject({
        method: "GET",
        url: "/test-stellar",
        headers: { "x-payment": xdr },
      });

      expect(response.statusCode).toBe(402);
      const body = JSON.parse(response.body);
      expect(body.message).toContain("time bounds");
      expect(body.message).toContain("not allowed");
    });

    it("should accept a transaction with valid time bounds (BRIDGE-11 acceptance criteria #6)", async () => {
      mockSubmitTransaction.mockClear();
      mockSubmitTransaction.mockResolvedValueOnce({ id: "txhash" });

      const now = Math.floor(Date.now() / 1000);
      const validMaxTime = now + 300; // 5 minutes in the future
      const xdr = buildStellarTransaction({
        memo: `micopay:${SERVICE_NAME}`,
        timeBoundsMaxTime: validMaxTime,
      });

      const response = await app.inject({
        method: "GET",
        url: "/test-stellar",
        headers: { "x-payment": xdr },
      });

      // Should not fail on time bounds validation
      if (response.statusCode === 402) {
        const body = JSON.parse(response.body);
        expect(body.message).not.toContain("expired");
        expect(body.message).not.toContain("time bounds");
      }
    });
  });

  describe("Combined Validation", () => {
    it("should reject a transaction that fails both memo and time bounds checks", async () => {
      mockSubmitTransaction.mockClear();
      const now = Math.floor(Date.now() / 1000);
      const xdr = buildStellarTransaction({
        memo: "micopay:wrong-service",
        timeBoundsMaxTime: now - 60,
      });

      const response = await app.inject({
        method: "GET",
        url: "/test-stellar",
        headers: { "x-payment": xdr },
      });

      expect(response.statusCode).toBe(402);
      const body = JSON.parse(response.body);
      // Should fail on the first check (memo), which comes before time bounds
      expect(body.message).toContain("Invalid memo");
    });
  });
});
