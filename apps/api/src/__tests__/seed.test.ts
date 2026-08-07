import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";

// ── Hoisted mutable state ──────────────────────────────────────────────────────
const mockConfig = vi.hoisted(() => ({ demoMode: true }));

vi.mock("../config.js", () => ({ config: mockConfig }));
vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn().mockResolvedValue("$2b$10$mockhash") },
}));

const queryCalls: Array<{ sql: string; params: any[] }> = [];
const mockQuery = vi.fn(async (sql: string, params?: any[]) => {
  queryCalls.push({ sql, params: params ?? [] });
  return { rows: [] };
});

vi.mock("../db/schema.js", () => ({
  query: mockQuery,
}));

// Import after mocks are set up
const { seedDemoData, DEMO_USER, DEMO_MERCHANT_ID, DEMO_TRADE_IDS } =
  await import("../scripts/seed.js");

// ── Helpers ────────────────────────────────────────────────────────────────────

function getInsertedIds(): {
  userIds: string[];
  merchantIds: string[];
  tradeIds: string[];
} {
  const userIds: string[] = [];
  const merchantIds: string[] = [];
  const tradeIds: string[] = [];

  for (const call of queryCalls) {
    const sql = call.sql.trim().toUpperCase();
    if (sql.startsWith("INSERT INTO USERS")) {
      userIds.push(call.params[0]);
    } else if (sql.startsWith("INSERT INTO MERCHANTS")) {
      merchantIds.push(call.params[0]);
    } else if (sql.startsWith("INSERT INTO TRADES")) {
      tradeIds.push(call.params[0]);
    }
  }

  return { userIds, merchantIds, tradeIds };
}

// ── Unit tests (sub-task 2.2) ──────────────────────────────────────────────────

describe("seedDemoData — demoMode=true", () => {
  beforeEach(() => {
    mockConfig.demoMode = true;
    queryCalls.length = 0;
    mockQuery.mockClear();
  });

  it("upserts the demo user with the fixed stellar address", async () => {
    await seedDemoData();

    const userCall = queryCalls.find(
      (c) =>
        c.sql.trim().toUpperCase().startsWith("INSERT INTO USERS") &&
        c.params.includes(DEMO_USER.stellar_address),
    );
    expect(userCall).toBeDefined();
    expect(userCall!.params).toContain(DEMO_USER.username);
    expect(userCall!.params).toContain(DEMO_USER.stellar_address);
  });

  it("upserts the demo merchant with MERCH_DEMO_001", async () => {
    await seedDemoData();

    const merchantCall = queryCalls.find(
      (c) =>
        c.sql.trim().toUpperCase().startsWith("INSERT INTO MERCHANTS") &&
        c.params[0] === DEMO_MERCHANT_ID,
    );
    expect(merchantCall).toBeDefined();
  });

  it("upserts a trade in each required state: pending, locked, completed, cancelled", async () => {
    await seedDemoData();

    const tradeCalls = queryCalls.filter((c) =>
      c.sql.trim().toUpperCase().startsWith("INSERT INTO TRADES"),
    );

    const insertedTradeIds = tradeCalls.map((c) => c.params[0]);
    expect(insertedTradeIds).toContain(DEMO_TRADE_IDS.pending);
    expect(insertedTradeIds).toContain(DEMO_TRADE_IDS.locked);
    expect(insertedTradeIds).toContain(DEMO_TRADE_IDS.completed);
    expect(insertedTradeIds).toContain(DEMO_TRADE_IDS.cancelled);
  });

  it("uses ON CONFLICT DO UPDATE for all upserts (idempotent SQL)", async () => {
    await seedDemoData();

    const insertCalls = queryCalls.filter((c) =>
      c.sql.trim().toUpperCase().startsWith("INSERT INTO"),
    );

    for (const call of insertCalls) {
      expect(call.sql.toUpperCase()).toContain("ON CONFLICT");
    }
  });

  it("stores a bcrypt hash (not plaintext) for the demo user password", async () => {
    await seedDemoData();

    const userCall = queryCalls.find(
      (c) =>
        c.sql.trim().toUpperCase().startsWith("INSERT INTO USERS") &&
        c.params.includes(DEMO_USER.stellar_address),
    );
    expect(userCall).toBeDefined();
    // password_hash param should be the mocked bcrypt hash, not the plaintext
    const passwordHashParam = userCall!.params.find((p: string) =>
      p.startsWith("$2b$"),
    );
    expect(passwordHashParam).toBeDefined();
    expect(userCall!.params).not.toContain(DEMO_USER.password);
  });
});

describe("seedDemoData — demoMode=false", () => {
  beforeEach(() => {
    mockConfig.demoMode = false;
    queryCalls.length = 0;
    mockQuery.mockClear();
  });

  it("returns early without writing any demo records", async () => {
    await seedDemoData();

    const { userIds, merchantIds, tradeIds } = getInsertedIds();
    expect(userIds).toHaveLength(0);
    expect(merchantIds).toHaveLength(0);
    expect(tradeIds).toHaveLength(0);
  });

  it("issues no SQL queries at all", async () => {
    await seedDemoData();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ── Property test (sub-task 2.1) ───────────────────────────────────────────────
// Feature: demo-mode, Property 2: calling seedDemoData() N times produces the same DB state

describe("Property 2: seed idempotence", () => {
  beforeEach(() => {
    mockConfig.demoMode = true;
  });

  it("calling seedDemoData() N times produces the same set of demo PKs each time", async () => {
    await fc.assert(
      fc.asyncProperty(
        // N between 2 and 5 consecutive calls
        fc.integer({ min: 2, max: 5 }),
        async (n) => {
          // Reset state before each property run
          queryCalls.length = 0;
          mockQuery.mockClear();
          mockConfig.demoMode = true;

          // Collect PKs from each individual call
          const pkSnapshots: {
            userIds: string[];
            merchantIds: string[];
            tradeIds: string[];
          }[] = [];

          for (let i = 0; i < n; i++) {
            queryCalls.length = 0;
            await seedDemoData();
            pkSnapshots.push(getInsertedIds());
          }

          // All snapshots must have identical PKs
          const first = pkSnapshots[0];
          for (const snapshot of pkSnapshots.slice(1)) {
            // Same number of upserts each call
            expect(snapshot.userIds).toHaveLength(first.userIds.length);
            expect(snapshot.merchantIds).toHaveLength(first.merchantIds.length);
            expect(snapshot.tradeIds).toHaveLength(first.tradeIds.length);

            // Same PKs each call
            expect(snapshot.userIds.sort()).toEqual(first.userIds.sort());
            expect(snapshot.merchantIds.sort()).toEqual(
              first.merchantIds.sort(),
            );
            expect(snapshot.tradeIds.sort()).toEqual(first.tradeIds.sort());
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
