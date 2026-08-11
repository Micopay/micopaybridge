import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

// PLATFORM_BASE_ADDRESS / BASE_CHAIN_ID / etc. are module-top-level consts in
// middleware/x402.ts (read once at import time, mirroring how PLATFORM_ADDRESS
// works for Stellar) — so this file sets env vars FIRST, then dynamically
// imports the module, rather than a static import (which vitest/ESM would
// hoist and evaluate before any of this file's own top-level code runs).

const mockVerifyTypedData = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockWriteContract = vi.hoisted(() => vi.fn().mockResolvedValue("0xaaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccdddd"));
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

const PLATFORM_BASE = "0x00000000000000000000000000000000000aaa";
const PAYER_FROM = "0x00000000000000000000000000000000000bbb";
const OTHER_PAYER_FROM = "0x00000000000000000000000000000000000ccc";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

// Unique per test-file run: if a real Postgres happens to be reachable (not
// mocked here — this suite exercises requirePayment's in-memory OR real DB
// fallback depending on what's actually running locally), hardcoded nonces
// would collide with rows a previous run already inserted and left behind,
// causing false "already used" failures. Mixing in a fresh random suffix
// keeps each run's replay keys unique regardless of what's in the DB.
const RUN_ID = Math.random().toString(16).slice(2).padEnd(8, "0").slice(0, 8);
function uniqueNonce(seedByte: string): string {
  return "0x" + seedByte.repeat(28) + RUN_ID; // 56 + 8 = 64 hex chars = 32 bytes
}

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

function basePayload(overrides: {
  from?: string;
  to?: string;
  value?: string;
  validAfter?: string;
  validBefore?: string;
  nonce?: string;
  network?: string;
} = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return b64({
    x402Version: 1,
    scheme: "exact",
    network: overrides.network ?? "base-sepolia",
    payload: {
      signature: "0x" + "11".repeat(65),
      authorization: {
        from: overrides.from ?? PAYER_FROM,
        to: overrides.to ?? PLATFORM_BASE,
        value: overrides.value ?? "1000", // 0.001 USDC @ 6 decimals
        validAfter: overrides.validAfter ?? String(now - 60),
        validBefore: overrides.validBefore ?? String(now + 300),
        nonce: overrides.nonce ?? uniqueNonce("22"),
      },
    },
  });
}

describe("Base payments (WP2)", () => {
  let app: FastifyInstance;
  let requirePayment: typeof import("../middleware/x402.js")["requirePayment"];

  beforeAll(async () => {
    process.env.X402_ACCEPT_CHAINS = "stellar,base";
    process.env.PLATFORM_BASE_ADDRESS = PLATFORM_BASE;
    process.env.BASE_CHAIN_ID = "84532";
    process.env.BASE_USDC_ADDRESS = USDC;
    process.env.RELAYER_EVM_PRIVATE_KEY = "0x" + "11".repeat(32);
    delete process.env.X402_FACILITATOR_URL; // force the self-submit (mocked) path

    const mod = await import("../middleware/x402.js");
    requirePayment = mod.requirePayment;

    app = Fastify();
    app.get(
      "/test-base",
      { preHandler: requirePayment({ amount: "0.001", service: "test-base" }) },
      async () => ({ ok: true })
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("402 challenge accepts[] lists both base and stellar", async () => {
    const res = await app.inject({ method: "GET", url: "/test-base" });
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.x402Version).toBe(1);
    const networks = body.accepts.map((a: { network: string }) => a.network);
    expect(networks).toContain("base-sepolia");
    expect(networks.some((n: string) => n.includes("test"))).toBe(true);
    // legacy shape still present, unnested
    expect(body.challenge.scheme).toBe("stellar-usdc");
  });

  it("accepts a valid EIP-3009 authorization", async () => {
    mockVerifyTypedData.mockResolvedValueOnce(true);
    const res = await app.inject({
      method: "GET",
      url: "/test-base",
      headers: { "x-payment": basePayload({ nonce: uniqueNonce("aa") }) },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects an invalid signature", async () => {
    mockVerifyTypedData.mockResolvedValueOnce(false);
    const res = await app.inject({
      method: "GET",
      url: "/test-base",
      headers: { "x-payment": basePayload({ nonce: uniqueNonce("bb") }) },
    });
    expect(res.statusCode).toBe(402);
  });

  it("rejects underpayment", async () => {
    mockVerifyTypedData.mockResolvedValueOnce(true);
    const res = await app.inject({
      method: "GET",
      url: "/test-base",
      headers: { "x-payment": basePayload({ nonce: uniqueNonce("cc"), value: "1" }) },
    });
    expect(res.statusCode).toBe(402);
  });

  it("rejects an expired authorization (validBefore passed)", async () => {
    mockVerifyTypedData.mockResolvedValueOnce(true);
    const now = Math.floor(Date.now() / 1000);
    const res = await app.inject({
      method: "GET",
      url: "/test-base",
      headers: {
        "x-payment": basePayload({
          nonce: uniqueNonce("dd"),
          validAfter: String(now - 600),
          validBefore: String(now - 60),
        }),
      },
    });
    expect(res.statusCode).toBe(402);
  });

  it("rejects a not-yet-valid authorization (validAfter in the future) — REV-4", async () => {
    mockVerifyTypedData.mockResolvedValueOnce(true);
    const now = Math.floor(Date.now() / 1000);
    const res = await app.inject({
      method: "GET",
      url: "/test-base",
      headers: {
        "x-payment": basePayload({
          nonce: uniqueNonce("ee"),
          validAfter: String(now + 600),
          validBefore: String(now + 900),
        }),
      },
    });
    expect(res.statusCode).toBe(402);
  });

  it("rejects a payment to the wrong destination address", async () => {
    mockVerifyTypedData.mockResolvedValueOnce(true);
    const res = await app.inject({
      method: "GET",
      url: "/test-base",
      headers: {
        "x-payment": basePayload({
          nonce: uniqueNonce("ff"),
          to: "0x0000000000000000000000000000000000dead",
        }),
      },
    });
    expect(res.statusCode).toBe(402);
  });

  it("rejects a replayed nonce from the SAME payer — REV-2", async () => {
    const nonce = uniqueNonce("12");
    mockVerifyTypedData.mockResolvedValue(true);

    const first = await app.inject({
      method: "GET",
      url: "/test-base",
      headers: { "x-payment": basePayload({ nonce }) },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "GET",
      url: "/test-base",
      headers: { "x-payment": basePayload({ nonce }) },
    });
    expect(second.statusCode).toBe(402);
  });

  it("accepts the SAME nonce from a DIFFERENT payer — REV-2", async () => {
    const nonce = uniqueNonce("34");
    mockVerifyTypedData.mockResolvedValue(true);

    const first = await app.inject({
      method: "GET",
      url: "/test-base",
      headers: { "x-payment": basePayload({ nonce, from: PAYER_FROM }) },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "GET",
      url: "/test-base",
      headers: { "x-payment": basePayload({ nonce, from: OTHER_PAYER_FROM }) },
    });
    expect(second.statusCode).toBe(200);
  });

  it("exactly one of two concurrent requests with the same payment succeeds — REV-3", async () => {
    const nonce = uniqueNonce("56");
    mockVerifyTypedData.mockResolvedValue(true);
    const header = basePayload({ nonce, from: "0x00000000000000000000000000000000000ddd" });

    const [a, b] = await Promise.all([
      app.inject({ method: "GET", url: "/test-base", headers: { "x-payment": header } }),
      app.inject({ method: "GET", url: "/test-base", headers: { "x-payment": header } }),
    ]);

    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 402]);
  });
});
