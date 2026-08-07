import { describe, it, expect } from "vitest";
import { createApp } from "../index.js";

describe("API app", () => {
  it("registers the Bazaar endpoints documented in the README", async () => {
    const app = await createApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bazaar/intent",
      payload: {
        offered: { chain: "ethereum", symbol: "ETH", amount: "1.2" },
        wanted: { chain: "stellar", symbol: "USDC", amount: "3200" },
      },
    });

    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).toBe(402);

    await app.close();
  });
});
