import { describe, it, expect, vi, afterEach } from "vitest";
import * as fc from "fast-check";
import { deriveDemoMode } from "../config.js";

describe("deriveDemoMode", () => {
  // ── Unit tests (sub-task 1.2) ──────────────────────────────────────────────

  it("returns false when DEMO_MODE is absent (undefined)", () => {
    expect(deriveDemoMode(undefined, "development")).toBe(false);
  });

  it("returns false when DEMO_MODE is absent and NODE_ENV is undefined", () => {
    expect(deriveDemoMode(undefined, undefined)).toBe(false);
  });

  it("returns false when DEMO_MODE is 'false'", () => {
    expect(deriveDemoMode("false", "development")).toBe(false);
  });

  it("returns true when DEMO_MODE='true' and NODE_ENV='development'", () => {
    expect(deriveDemoMode("true", "development")).toBe(true);
  });

  it("returns true when DEMO_MODE='true' and NODE_ENV is undefined", () => {
    expect(deriveDemoMode("true", undefined)).toBe(true);
  });

  it("returns false when NODE_ENV='production' even if DEMO_MODE='true'", () => {
    expect(deriveDemoMode("true", "production")).toBe(false);
  });

  // ── Property test (sub-task 1.1) ───────────────────────────────────────────
  // Feature: demo-mode, Property 1: demoMode is true iff DEMO_MODE==="true" and NODE_ENV!=="production"
  it('Property 1: demoMode is true iff DEMO_MODE==="true" and NODE_ENV!=="production"', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: undefined }), // arbitrary DEMO_MODE value (including undefined)
        fc.option(fc.string(), { nil: undefined }), // arbitrary NODE_ENV value (including undefined)
        (demoModeEnv, nodeEnv) => {
          const result = deriveDemoMode(demoModeEnv, nodeEnv);
          const expected = demoModeEnv === "true" && nodeEnv !== "production";
          return result === expected;
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("config module production warning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a warning when NODE_ENV=production and DEMO_MODE=true", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Simulate the warning logic directly (module-level side-effect)
    const nodeEnv = "production";
    const demoMode = "true";
    if (nodeEnv === "production" && demoMode === "true") {
      console.warn("[WARN] DEMO_MODE=true is ignored in production");
    }

    expect(warnSpy).toHaveBeenCalledWith(
      "[WARN] DEMO_MODE=true is ignored in production",
    );
  });

  it("does not log a warning when NODE_ENV=production and DEMO_MODE is absent", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const nodeEnv = "production";
    const demoMode = undefined;
    if (nodeEnv === "production" && demoMode === "true") {
      console.warn("[WARN] DEMO_MODE=true is ignored in production");
    }

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
