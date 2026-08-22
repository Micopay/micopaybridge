import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const initBazaarTables = vi.hoisted(() => vi.fn());
const seedAgentHistories = vi.hoisted(() => vi.fn());
const seedIntents = vi.hoisted(() => vi.fn());

vi.mock("../db/bazaar.js", () => ({
  initBazaarTables,
  seedAgentHistories,
  seedIntents,
  createIntent: vi.fn(),
  getIntent: vi.fn(),
  getActiveIntents: vi.fn(),
  updateIntent: vi.fn(),
  createQuote: vi.fn(),
  getQuotesForIntent: vi.fn(),
  getAgentHistory: vi.fn(),
  upsertAgentHistory: vi.fn(),
  intentRowToObject: vi.fn(),
  getBazaarStats: vi.fn(),
}));

describe("Bazaar DB initialization retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    process.env.BAZAAR_DB_RETRY_MS = "1000";
    initBazaarTables.mockReset();
    seedAgentHistories.mockReset();
    seedIntents.mockReset();
    seedAgentHistories.mockResolvedValue(undefined);
    seedIntents.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.BAZAAR_DB_RETRY_MS;
  });

  it("retries after the interval and completes initialization", async () => {
    initBazaarTables
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(undefined);

    const { ensureBazaarInitialized } = await import("../routes/bazaar.js");
    await ensureBazaarInitialized();
    await ensureBazaarInitialized();
    expect(initBazaarTables).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    await ensureBazaarInitialized();

    expect(initBazaarTables).toHaveBeenCalledTimes(2);
    expect(seedAgentHistories).toHaveBeenCalledTimes(1);
    expect(seedIntents).toHaveBeenCalledTimes(1);
  });
});
