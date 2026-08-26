import { describe, it, expect, vi, afterEach } from "vitest";
import { initBazaarTables } from "../db/bazaar.js";
import { query } from "../db/schema.js";

vi.mock("../db/schema.js", () => {
  return {
    query: vi.fn(),
  };
});

describe("initBazaarTables", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should not throw if tables exist", async () => {
    vi.mocked(query).mockResolvedValueOnce({
      rows: [{ exists: true }],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: []
    } as any);

    await expect(initBazaarTables()).resolves.not.toThrow();
    
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SELECT EXISTS"));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("bazaar_intents"));
  });

  it("should throw if tables do not exist", async () => {
    vi.mocked(query).mockResolvedValueOnce({
      rows: [{ exists: false }],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: []
    } as any);

    await expect(initBazaarTables()).rejects.toThrowError(
      'Bazaar tables are missing. Please run `npm run db:setup` or ensure migrations have run.'
    );
  });
});
