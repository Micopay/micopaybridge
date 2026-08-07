#!/usr/bin/env node
import { query } from "../db/schema.js";
import { initX402Tables } from "../db/x402.js";
import {
  initBazaarTables,
  seedAgentHistories,
  seedIntents,
} from "../db/bazaar.js";
import { config } from "../config.js";
import bcrypt from "bcryptjs";

// ── Demo Mode Constants ────────────────────────────────────────────────────────

export const DEMO_USER = {
  // UUID v5-style fixed ID derived from the demo stellar address
  id: "00000000-0000-0000-0000-demo00000001",
  username: "demo_reviewer",
  // Valid 56-char Stellar public key (deterministic demo keypair)
  stellar_address:
    "GDEMOREVIEWER1111111111111111111111111111111111111111111111",
  password: "MicoPay-Review-2025",
} as const;

export const DEMO_MERCHANT_ID = "MERCH_DEMO_001";

// Fixed UUIDs for demo trades — one per required state
export const DEMO_TRADE_IDS = {
  pending: "00000000-demo-0000-0000-000000000001",
  locked: "00000000-demo-0000-0000-000000000002",
  completed: "00000000-demo-0000-0000-000000000003",
  cancelled: "00000000-demo-0000-0000-000000000004",
} as const;

/**
 * Seed demo data for app store reviewer sessions.
 * Idempotent — safe to call on every API restart.
 * No-ops when config.demoMode === false.
 */
export async function seedDemoData(): Promise<void> {
  if (!config.demoMode) {
    return;
  }

  console.log("\n🎭 Seeding demo data...");

  // Ensure users table has password_hash column (demo-only addition)
  await query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(72)
  `);

  // ── 1. Upsert demo user ──────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash(DEMO_USER.password, 10);

  await query(
    `
    INSERT INTO users (id, stellar_address, username, password_hash)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (id) DO UPDATE SET
      stellar_address = EXCLUDED.stellar_address,
      username        = EXCLUDED.username,
      password_hash   = EXCLUDED.password_hash
  `,
    [DEMO_USER.id, DEMO_USER.stellar_address, DEMO_USER.username, passwordHash],
  );

  console.log("   ✅ Demo user upserted (demo_reviewer)");

  // ── 2. Upsert demo merchant ──────────────────────────────────────────────────
  await query(
    `
    INSERT INTO merchants (
      id, stellar_address, name, type, address, lat, lng,
      available_mxn, max_trade_mxn, min_trade_mxn, tier,
      completion_rate, trades_completed, trades_cancelled, volume_usdc,
      avg_time_minutes, online
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    ON CONFLICT (id) DO UPDATE SET
      available_mxn = EXCLUDED.available_mxn,
      online        = EXCLUDED.online,
      updated_at    = NOW()
  `,
    [
      DEMO_MERCHANT_ID,
      "GDEMO1MERCHANT111111111111111111111111111111111111111111111",
      "Demo Merchant",
      "tienda",
      "Demo Street 1, Demo City",
      19.4195,
      -99.1627,
      10000,
      5000,
      100,
      "maestro",
      0.99,
      500,
      5,
      150000,
      3,
      true,
    ],
  );

  console.log("   ✅ Demo merchant upserted (MERCH_DEMO_001)");

  // ── 3. Upsert four demo trades ───────────────────────────────────────────────
  const demoSecretHash = "a".repeat(64); // fixed placeholder hash for demo trades

  // pending trade
  await query(
    `
    INSERT INTO trades (
      id, seller_id, buyer_id, amount_mxn, amount_stroops,
      seller_fee_mxn, platform_fee_mxn, secret_hash, status, expires_at
    ) VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, NOW() + INTERVAL '24 hours')
    ON CONFLICT (id) DO UPDATE SET
      status     = EXCLUDED.status,
      expires_at = EXCLUDED.expires_at
  `,
    [
      DEMO_TRADE_IDS.pending,
      DEMO_USER.id,
      500,
      50000000,
      5,
      2,
      demoSecretHash,
      "pending",
    ],
  );

  // locked trade
  await query(
    `
    INSERT INTO trades (
      id, seller_id, buyer_id, amount_mxn, amount_stroops,
      seller_fee_mxn, platform_fee_mxn, secret_hash, status,
      locked_at, expires_at
    ) VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, NOW() - INTERVAL '10 minutes', NOW() + INTERVAL '14 hours')
    ON CONFLICT (id) DO UPDATE SET
      status    = EXCLUDED.status,
      locked_at = EXCLUDED.locked_at
  `,
    [
      DEMO_TRADE_IDS.locked,
      DEMO_USER.id,
      1000,
      100000000,
      10,
      4,
      demoSecretHash,
      "locked",
    ],
  );

  // completed trade — completed_at set, secrets cleared
  await query(
    `
    INSERT INTO trades (
      id, seller_id, buyer_id, amount_mxn, amount_stroops,
      seller_fee_mxn, platform_fee_mxn, secret_hash,
      secret_enc, secret_nonce, status, completed_at, expires_at
    ) VALUES ($1, $2, $2, $3, $4, $5, $6, $7, NULL, NULL, $8, NOW() - INTERVAL '1 day', NOW() - INTERVAL '22 hours')
    ON CONFLICT (id) DO UPDATE SET
      status       = EXCLUDED.status,
      completed_at = EXCLUDED.completed_at,
      secret_enc   = NULL,
      secret_nonce = NULL
  `,
    [
      DEMO_TRADE_IDS.completed,
      DEMO_USER.id,
      750,
      75000000,
      7,
      3,
      demoSecretHash,
      "completed",
    ],
  );

  // cancelled trade — secrets cleared
  await query(
    `
    INSERT INTO trades (
      id, seller_id, buyer_id, amount_mxn, amount_stroops,
      seller_fee_mxn, platform_fee_mxn, secret_hash,
      secret_enc, secret_nonce, status, expires_at
    ) VALUES ($1, $2, $2, $3, $4, $5, $6, $7, NULL, NULL, $8, NOW() - INTERVAL '2 days')
    ON CONFLICT (id) DO UPDATE SET
      status       = EXCLUDED.status,
      secret_enc   = NULL,
      secret_nonce = NULL
  `,
    [
      DEMO_TRADE_IDS.cancelled,
      DEMO_USER.id,
      300,
      30000000,
      3,
      1,
      demoSecretHash,
      "cancelled",
    ],
  );

  console.log(
    "   ✅ Demo trades upserted (pending, locked, completed, cancelled)",
  );
  console.log("🎭 Demo seed complete.\n");
}

const LOGO = `
╔══════════════════════════════════════════════════════╗
║          MicoPay Protocol - Database Seeder        ║
╚══════════════════════════════════════════════════════╝
`;

async function waitForDatabase(maxRetries = 30) {
  console.log("⏳ Waiting for database connection...");
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await query("SELECT 1");
      if (result.rows[0]) {
        console.log("✅ Database connected!");
        return true;
      }
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

async function seedMerchants() {
  console.log("\n📍 Seeding merchants...");

  const merchants = [
    {
      id: "MERCH001",
      stellar_address:
        "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKUJI5KOOJ9TXWNTBBS2JN",
      name: "Farmacia Guadalupe",
      type: "farmacia",
      address: "Orizaba 45, Col. Roma Norte, CDMX",
      lat: 19.4195,
      lng: -99.1627,
      available_mxn: 5000,
      max_trade_mxn: 3000,
      min_trade_mxn: 100,
      tier: "maestro",
      completion_rate: 0.98,
      trades_completed: 312,
      trades_cancelled: 6,
      volume_usdc: 241500,
      avg_time_minutes: 4,
      online: true,
    },
    {
      id: "MERCH002",
      stellar_address:
        "GDAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A",
      name: "Tienda Don Pepe",
      type: "tienda",
      address: "Av. Álvaro Obregón 120, Col. Roma Norte, CDMX",
      lat: 19.4165,
      lng: -99.158,
      available_mxn: 3000,
      max_trade_mxn: 2000,
      min_trade_mxn: 200,
      tier: "experto",
      completion_rate: 0.93,
      trades_completed: 156,
      trades_cancelled: 12,
      volume_usdc: 52300,
      avg_time_minutes: 7,
      online: true,
    },
    {
      id: "MERCH003",
      stellar_address:
        "GCF3CJXADZKIODEGZHTBQKPAGMO5KYVW6SLJ3J5GBQZDIFHGT7ZZQMFB",
      name: "Papelería La Central",
      type: "papeleria",
      address: "Col. Condesa, CDMX",
      lat: 19.411,
      lng: -99.174,
      available_mxn: 2000,
      max_trade_mxn: 1500,
      min_trade_mxn: 100,
      tier: "activo",
      completion_rate: 0.88,
      trades_completed: 45,
      trades_cancelled: 6,
      volume_usdc: 12800,
      avg_time_minutes: 5,
      online: true,
    },
    {
      id: "MERCH004",
      stellar_address:
        "GDTEZWGQB7V2CLS6GVKWM4B3F5QMT6BJ2UJH7D3O5XFJJJENOTK3YUD5",
      name: "Consultorio Dr. Martínez",
      type: "consultorio",
      address: "Col. Del Valle, CDMX",
      lat: 19.396,
      lng: -99.1755,
      available_mxn: 8000,
      max_trade_mxn: 5000,
      min_trade_mxn: 500,
      tier: "espora",
      completion_rate: 0.75,
      trades_completed: 12,
      trades_cancelled: 4,
      volume_usdc: 3200,
      avg_time_minutes: 10,
      online: false,
    },
    {
      id: "MERCH005",
      stellar_address:
        "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4B",
      name: "Abarrotes El Güero",
      type: "abarrotes",
      address: "Insurgentes Sur 2500, CDMX",
      lat: 19.403,
      lng: -99.168,
      available_mxn: 1500,
      max_trade_mxn: 1000,
      min_trade_mxn: 50,
      tier: "activo",
      completion_rate: 0.85,
      trades_completed: 78,
      trades_cancelled: 14,
      volume_usdc: 18500,
      avg_time_minutes: 6,
      online: true,
    },
  ];

  await query(`
    CREATE TABLE IF NOT EXISTS merchants (
      id                  VARCHAR(32) PRIMARY KEY,
      stellar_address     VARCHAR(56) NOT NULL UNIQUE,
      name               VARCHAR(100) NOT NULL,
      type               VARCHAR(50),
      address            TEXT,
      lat                DECIMAL(10, 8),
      lng                DECIMAL(11, 8),
      available_mxn      DECIMAL(12, 2) DEFAULT 0,
      max_trade_mxn      DECIMAL(12, 2) DEFAULT 0,
      min_trade_mxn      DECIMAL(12, 2) DEFAULT 0,
      tier               VARCHAR(20) DEFAULT 'espora',
      completion_rate     DECIMAL(5, 4) DEFAULT 0,
      trades_completed   INTEGER DEFAULT 0,
      trades_cancelled   INTEGER DEFAULT 0,
      volume_usdc        DECIMAL(20, 2) DEFAULT 0,
      avg_time_minutes   INTEGER DEFAULT 10,
      online             BOOLEAN DEFAULT false,
      verified           BOOLEAN DEFAULT false,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(
    `CREATE INDEX IF NOT EXISTS idx_merchants_location ON merchants(lat, lng)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_merchants_tier ON merchants(tier)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_merchants_online ON merchants(online)`,
  );

  for (const m of merchants) {
    await query(
      `
      INSERT INTO merchants (
        id, stellar_address, name, type, address, lat, lng,
        available_mxn, max_trade_mxn, min_trade_mxn, tier,
        completion_rate, trades_completed, trades_cancelled, volume_usdc,
        avg_time_minutes, online
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (id) DO UPDATE SET
        available_mxn = EXCLUDED.available_mxn,
        online = EXCLUDED.online,
        updated_at = NOW()
    `,
      [
        m.id,
        m.stellar_address,
        m.name,
        m.type,
        m.address,
        m.lat,
        m.lng,
        m.available_mxn,
        m.max_trade_mxn,
        m.min_trade_mxn,
        m.tier,
        m.completion_rate,
        m.trades_completed,
        m.trades_cancelled,
        m.volume_usdc,
        m.avg_time_minutes,
        m.online,
      ],
    );
  }

  console.log(`   ✅ ${merchants.length} merchants seeded`);
  return merchants.length;
}

async function seedX402Payments() {
  console.log("\n💰 Seeding sample x402 payments...");

  await initX402Tables();

  const payments = [
    {
      tx_hash: "abc123def456",
      payer: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKUJI5KOOJ9TXWNTBBS2JN",
      amount: "0.005",
      service: "bazaar_broadcast",
    },
    {
      tx_hash: "def456abc789",
      payer: "GDAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A",
      amount: "0.001",
      service: "bazaar_feed",
    },
    {
      tx_hash: "ghi789jkl012",
      payer: "GCF3CJXADZKIODEGZHTBQKPAGMO5KYVW6SLJ3J5GBQZDIFHGT7ZZQMFB",
      amount: "0.01",
      service: "cash_request",
    },
  ];

  for (const p of payments) {
    await query(
      `
      INSERT INTO x402_payments (tx_hash, payer_address, amount_usdc, service, expires_at, used)
      VALUES ($1, $2, $3, $4, $5, TRUE)
      ON CONFLICT (tx_hash) DO NOTHING
    `,
      [
        p.tx_hash,
        p.payer,
        p.amount,
        p.service,
        new Date(Date.now() - 24 * 60 * 60 * 1000),
      ],
    );
  }

  console.log(`   ✅ ${payments.length} sample payments seeded`);
  return payments.length;
}

async function seedSwapHistory() {
  console.log("\n🔄 Seeding swap history...");

  await query(`
    CREATE TABLE IF NOT EXISTS swap_history (
      id              SERIAL PRIMARY KEY,
      swap_id         VARCHAR(64) UNIQUE,
      initiator       VARCHAR(56) NOT NULL,
      counterparty    VARCHAR(56),
      offered_chain   VARCHAR(32),
      offered_symbol  VARCHAR(16),
      offered_amount  VARCHAR(32),
      wanted_chain    VARCHAR(32),
      wanted_symbol   VARCHAR(16),
      wanted_amount   VARCHAR(32),
      rate            DECIMAL(10, 6),
      status          VARCHAR(20) DEFAULT 'pending',
      htlc_tx_hash   VARCHAR(64),
      secret_hash     VARCHAR(72),
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      completed_at    TIMESTAMPTZ
    )
  `);

  const swaps = [
    {
      swap_id: "SWAP001",
      initiator: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKUJI5KOOJ9TXWNTBBS2JN",
      counterparty: "GDAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A",
      offered_chain: "ethereum",
      offered_symbol: "ETH",
      offered_amount: "1.5",
      wanted_chain: "stellar",
      wanted_symbol: "USDC",
      wanted_amount: "4200",
      rate: 0.95,
      status: "completed",
    },
    {
      swap_id: "SWAP002",
      initiator: "GDAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A",
      counterparty: "GCF3CJXADZKIODEGZHTBQKPAGMO5KYVW6SLJ3J5GBQZDIFHGT7ZZQMFB",
      offered_chain: "stellar",
      offered_symbol: "USDC",
      offered_amount: "1000",
      wanted_chain: "bitcoin",
      wanted_symbol: "BTC",
      wanted_amount: "0.025",
      rate: 0.92,
      status: "completed",
    },
    {
      swap_id: "SWAP003",
      initiator: "GCF3CJXADZKIODEGZHTBQKPAGMO5KYVW6SLJ3J5GBQZDIFHGT7ZZQMFB",
      offered_chain: "solana",
      offered_symbol: "SOL",
      offered_amount: "50",
      wanted_chain: "stellar",
      wanted_symbol: "USDC",
      wanted_amount: "8750",
      rate: 0.88,
      status: "completed",
    },
    {
      swap_id: "SWAP004",
      initiator: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKUJI5KOOJ9TXWNTBBS2JN",
      counterparty: "GDTEZWGQB7V2CLS6GVKWM4B3F5QMT6BJ2UJH7D3O5XFJJJENOTK3YUD5",
      offered_chain: "ethereum",
      offered_symbol: "ETH",
      offered_amount: "2.5",
      wanted_chain: "stellar",
      wanted_symbol: "USDC",
      wanted_amount: "7000",
      rate: 0.93,
      status: "executed",
    },
  ];

  for (const s of swaps) {
    await query(
      `
      INSERT INTO swap_history (swap_id, initiator, counterparty, offered_chain, offered_symbol, offered_amount, wanted_chain, wanted_symbol, wanted_amount, rate, status, completed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (swap_id) DO NOTHING
    `,
      [
        s.swap_id,
        s.initiator,
        s.counterparty,
        s.offered_chain,
        s.offered_symbol,
        s.offered_amount,
        s.wanted_chain,
        s.wanted_symbol,
        s.wanted_amount,
        s.rate,
        s.status,
        new Date(),
      ],
    );
  }

  console.log(`   ✅ ${swaps.length} sample swaps seeded`);
  return swaps.length;
}

async function getStats() {
  const tables = [
    "merchants",
    "bazaar_intents",
    "bazaar_quotes",
    "agent_history",
    "x402_payments",
    "swap_history",
  ];
  const stats: Record<string, number> = {};

  for (const table of tables) {
    try {
      const result = await query(`SELECT COUNT(*) as count FROM ${table}`);
      stats[table] = parseInt(result.rows[0]?.count ?? "0", 10);
    } catch {
      stats[table] = 0;
    }
  }

  return stats;
}

async function main() {
  console.log(LOGO);

  try {
    await waitForDatabase();

    console.log("\n🚀 Starting database seed...");

    const merchantsCount = await seedMerchants();
    await seedAgentHistories();
    await seedIntents();
    await seedX402Payments();
    await seedSwapHistory();

    const stats = await getStats();

    console.log("\n╔══════════════════════════════════════════════════════╗");
    console.log("║                    SEED COMPLETE                     ║");
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log(
      `║  Merchants:        ${String(stats.merchants).padStart(32)}║`,
    );
    console.log(
      `║  Bazaar Intents:   ${String(stats.bazaar_intents).padStart(32)}║`,
    );
    console.log(
      `║  Agent History:   ${String(stats.agent_history).padStart(32)}║`,
    );
    console.log(
      `║  X402 Payments:   ${String(stats.x402_payments).padStart(32)}║`,
    );
    console.log(
      `║  Swap History:    ${String(stats.swap_history).padStart(32)}║`,
    );
    console.log("╚══════════════════════════════════════════════════════╝");

    console.log("\n✅ Database seeded successfully!");
    console.log("\nNext steps:");
    console.log("  1. Start the API: npm run dev");
    console.log("  2. Test endpoints: curl http://localhost:3000/health");
    console.log(
      "  3. Check merchants: curl http://localhost:3000/api/v1/cash/agents",
    );
  } catch (error) {
    console.error("\n❌ Seed failed:", error);
    process.exit(1);
  } finally {
  }
}

// Only run the seeder when this file is executed directly (e.g. `tsx src/scripts/seed.ts`),
// NOT when it is imported for its exports (e.g. demo.ts imports DEMO_USER). Importing a
// module must not run a seeder or call process.exit.
import { fileURLToPath } from "node:url";
const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}
