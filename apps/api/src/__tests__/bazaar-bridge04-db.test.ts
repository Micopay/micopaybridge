import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * BRIDGE-04 — the SQL half.
 *
 * Why this is a separate file instead of extending bazaar.test.ts or
 * bazaar-bridge04.test.ts: those suites test the routes with the whole
 * db/bazaar.js module mocked, so they structurally cannot exercise the SQL
 * inside db/bazaar.ts — deleting `AND expires_at > NOW()` or the sweep would
 * leave them green. This file flips the mock boundary: the REAL db/bazaar.js
 * runs against a mocked db/schema.js, so the UPDATE sweep and the feed's WHERE
 * clause are the thing under test. Runs offline, no database involved.
 */

const schema = vi.hoisted(() => ({
  query: vi.fn(),
  getOne: vi.fn(),
  getMany: vi.fn(),
}));

vi.mock("../db/schema.js", () => schema);

import { expireStaleIntents, getActiveIntents } from "../db/bazaar.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("expireStaleIntents — the sweep UPDATE (BRIDGE-04)", () => {
  it("flips only 'active' intents past expires_at to 'expired'", async () => {
    schema.query.mockResolvedValue({ rowCount: 2, rows: [] });

    const count = await expireStaleIntents();

    expect(count).toBe(2);
    const sql: string = schema.query.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE bazaar_intents/i);
    expect(sql).toContain("SET status = 'expired'");
    expect(sql).toContain("expires_at <= NOW()");
    // A negotiating intent has an on-chain HTLC behind it — the sweep must not
    // label it expired while the lock may still be live on chain.
    expect(sql).toContain("status = 'active'");
    expect(sql).not.toContain("negotiating");
  });

  it("returns rowCount straight from pg's QueryResult (0 or null → 0)", async () => {
    schema.query.mockResolvedValue({ rowCount: 0, rows: [] });
    expect(await expireStaleIntents()).toBe(0);

    schema.query.mockResolvedValue({ rowCount: null, rows: [] });
    expect(await expireStaleIntents()).toBe(0);
  });
});

describe("getActiveIntents — the feed SELECT (BRIDGE-04)", () => {
  it("runs the expiry sweep before reading the feed", async () => {
    schema.query.mockResolvedValue({ rowCount: 1, rows: [] });
    schema.getMany.mockResolvedValue([]);

    await getActiveIntents();

    expect(schema.query).toHaveBeenCalledTimes(1);
    const sweepSql: string = schema.query.mock.calls[0][0];
    expect(sweepSql).toContain("UPDATE bazaar_intents");
    expect(sweepSql).toContain("status = 'active'");
    expect(sweepSql).not.toContain("negotiating");
  });

  it("selects only intents that are active AND not yet expired", async () => {
    schema.query.mockResolvedValue({ rowCount: 0, rows: [] });
    const liveRow = {
      id: "int-live",
      status: "active",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    schema.getMany.mockResolvedValue([liveRow]);

    const rows = await getActiveIntents();

    expect(rows).toEqual([liveRow]);
    const selectSql: string = schema.getMany.mock.calls[0][0];
    expect(selectSql).toMatch(/SELECT \* FROM bazaar_intents/i);
    expect(selectSql).toContain("status = 'active'");
    // The exclusion must live in the WHERE clause — if this predicate is
    // removed, an expired intent is back in the feed and this test fails.
    expect(selectSql).toContain("expires_at > NOW()");
  });
});
