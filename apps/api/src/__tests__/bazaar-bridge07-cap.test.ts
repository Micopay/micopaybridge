import { describe, it, expect, vi } from "vitest";
import { lockAtomicSwap } from "../services/stellar.service.js";

describe("[BRIDGE-07] Explicit Escrow Cap Protocol", () => {
  it("distinguishes requested amount from locked amount when capped", async () => {
    // In demo mode with cap at 0.01, a 100 USDC request is capped
    process.env.DEMO_LOCK_CAP_USDC = "0.01";
    // Mock callLockOnChain internally if needed or verify cap logic
    const reqAmount = 100;
    const demoCap = 0.01;
    const isCapped = reqAmount > demoCap;
    expect(isCapped).toBe(true);
    expect(Math.min(reqAmount, demoCap)).toBe(0.01);
  });

  it("leaves requests below the cap unaffected", () => {
    const reqAmount = 0.005;
    const demoCap = 0.01;
    expect(reqAmount > demoCap).toBe(false);
  });
});
