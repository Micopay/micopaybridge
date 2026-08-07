import { query, getOne, getMany, execute } from "./schema.js";

export type VerificationStatus = "pending" | "verified" | "paused";

export interface MerchantRow {
  id: string;
  user_id: string;
  display_name: string;
  latitude: number;
  longitude: number;
  address_text: string;
  hours_open: string; // HH:MM
  hours_close: string; // HH:MM
  base_rate: number;
  spread_percent: number;
  min_amount: number;
  max_amount: number;
  verification_status: VerificationStatus;
  verified_at: string | null;
  trades_completed: number;
  completion_rate: number;
  avg_time_minutes: number;
  tier: "maestro" | "experto" | "activo" | "espora";
  total_volume_usdc: number;
  last_trade_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicMerchantRow {
  id: string;
  display_name: string;
  latitude: number;
  longitude: number;
  address_text: string;
  hours_open: string;
  hours_close: string;
  base_rate: number;
  spread_percent: number;
  min_amount: number;
  max_amount: number;
  trades_completed: number;
  completion_rate: number;
  avg_time_minutes: number;
  tier: "maestro" | "experto" | "activo" | "espora";
  total_volume_usdc: number;
  last_trade_at: string | null;
}

export interface CreateMerchantInput {
  user_id: string;
  display_name: string;
  latitude: number;
  longitude: number;
  address_text: string;
  hours_open: string;
  hours_close: string;
  base_rate: number;
  spread_percent: number;
  min_amount: number;
  max_amount: number;
}

export async function initMerchantsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS merchants (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      display_name        VARCHAR(60) NOT NULL,
      latitude            DECIMAL(10, 7) NOT NULL,
      longitude           DECIMAL(10, 7) NOT NULL,
      address_text        TEXT NOT NULL,
      hours_open          VARCHAR(5) NOT NULL,
      hours_close         VARCHAR(5) NOT NULL,
      base_rate           DECIMAL(12, 6) NOT NULL,
      spread_percent      DECIMAL(7, 4) NOT NULL CHECK (spread_percent >= 0),
      min_amount          DECIMAL(15, 2) NOT NULL CHECK (min_amount > 0),
      max_amount          DECIMAL(15, 2) NOT NULL CHECK (max_amount > min_amount),
      verification_status VARCHAR(10) NOT NULL DEFAULT 'pending'
                            CHECK (verification_status IN ('pending', 'verified', 'paused')),
      verified_at         TIMESTAMPTZ,
      trades_completed    INTEGER NOT NULL DEFAULT 0,
      completion_rate     DECIMAL(5,4) NOT NULL DEFAULT 0,
      avg_time_minutes    INTEGER NOT NULL DEFAULT 0,
      tier                VARCHAR(10) NOT NULL DEFAULT 'espora'
                          CHECK (tier IN ('maestro', 'experto', 'activo', 'espora')),
      total_volume_usdc   DECIMAL(20,2) NOT NULL DEFAULT 0,
      last_trade_at       TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT merchants_user_unique UNIQUE (user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_merchants_user_id ON merchants(user_id);
    CREATE INDEX IF NOT EXISTS idx_merchants_status  ON merchants(verification_status);
    CREATE INDEX IF NOT EXISTS idx_merchants_tier    ON merchants(tier);
  `);
}

export async function createMerchant(
  data: CreateMerchantInput,
): Promise<MerchantRow> {
  const result = await getOne<MerchantRow>(
    `
    INSERT INTO merchants (
      user_id, display_name, latitude, longitude, address_text,
      hours_open, hours_close, base_rate, spread_percent, min_amount, max_amount
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING *
  `,
    [
      data.user_id,
      data.display_name,
      data.latitude,
      data.longitude,
      data.address_text,
      data.hours_open,
      data.hours_close,
      data.base_rate,
      data.spread_percent,
      data.min_amount,
      data.max_amount,
    ],
  );
  return result as MerchantRow;
}

export async function getMerchantByUserId(
  userId: string,
): Promise<MerchantRow | null> {
  return getOne<MerchantRow>("SELECT * FROM merchants WHERE user_id = $1", [
    userId,
  ]);
}

export async function getVerifiedMerchants(): Promise<PublicMerchantRow[]> {
  return getMany<PublicMerchantRow>(`
    SELECT id, display_name, latitude, longitude, address_text,
           hours_open, hours_close, base_rate, spread_percent, min_amount, max_amount,
           trades_completed, completion_rate, avg_time_minutes, tier,
           total_volume_usdc, last_trade_at
    FROM merchants
    WHERE verification_status = 'verified'
    ORDER BY tier = 'maestro' DESC, completion_rate DESC, trades_completed DESC
  `);
}

export async function getMerchantById(id: string): Promise<PublicMerchantRow | null> {
  return getOne<PublicMerchantRow>(`
    SELECT id, display_name, latitude, longitude, address_text,
           hours_open, hours_close, base_rate, spread_percent, min_amount, max_amount,
           trades_completed, completion_rate, avg_time_minutes, tier,
           total_volume_usdc, last_trade_at
    FROM merchants
    WHERE id = $1 AND verification_status = 'verified'
  `, [id]);
}
