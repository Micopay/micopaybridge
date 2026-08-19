import { describe, it, expect } from "vitest";
import { createApp } from "../index.js";

// These tests must not touch network or database: createApp() + inject only.

describe("GET /skill.md", () => {
  it("returns 200 with content-type text/markdown", async () => {
    const app = await createApp();
    try {
      const res = await app.inject({ method: "GET", url: "/skill.md" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/markdown");
      expect(res.body).toContain("MicoPay");
      expect(res.body).toContain("X-PAYMENT");
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/v1/services catalog matches the priced routes", () => {
  it("advertises every previously-missing priced endpoint at its enforced price", async () => {
    const app = await createApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/services" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        services: { name: string; endpoint: string; price_usdc: string | null }[];
      };
      const byName = new Map(body.services.map((s) => [s.name, s]));

      const expected: Record<string, string> = {
        swap_search: "0.001",
        swap_plan: "0.01",
        swap_execute: "0.05",
        swap_status: "0.0001",
        bazaar_accept: "0.005",
        cash_request_status: "0.0001",
      };
      for (const [name, price] of Object.entries(expected)) {
        expect(byName.get(name), `catalog is missing ${name}`).toBeDefined();
        expect(byName.get(name)!.price_usdc).toBe(price);
      }
    } finally {
      await app.close();
    }
  });

  it("does not advertise a chargeable price for reputation while it returns 501 (disabled by default)", async () => {
    const app = await createApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/services" });
      const body = res.json() as {
        services: { name: string; price_usdc: string | null; available?: boolean }[];
      };
      const reputation = body.services.find((s) => s.name === "reputation");
      expect(reputation).toBeDefined();
      expect(reputation!.available).toBe(false);
      // price_usdc is omitted (not null) while disabled, so no chargeable price
      // is advertised and strict string-parsers don't break on a type change.
      expect(reputation!.price_usdc).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
