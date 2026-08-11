-- Initial Schema Migration
-- UUID extension for PostgreSQL
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stellar_address VARCHAR(56) NOT NULL UNIQUE,
  username        VARCHAR(30) NOT NULL UNIQUE,
  password_hash   VARCHAR(72),
  phone_hash      VARCHAR(64),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Wallets table
CREATE TABLE IF NOT EXISTS wallets (
  id              SERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stellar_address VARCHAR(56) NOT NULL,
  wallet_type     VARCHAR(20) DEFAULT 'stellar',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wallets_user_unique UNIQUE (user_id)
);

-- Auth Challenges table
CREATE TABLE IF NOT EXISTS auth_challenges (
  id              SERIAL PRIMARY KEY,
  stellar_address VARCHAR(56) NOT NULL,
  challenge       VARCHAR(128) NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_address_expires ON auth_challenges(stellar_address, expires_at);

-- Merchants table (Consolidated)
CREATE TABLE IF NOT EXISTS merchants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID REFERENCES users(id) ON DELETE CASCADE,
  stellar_address     VARCHAR(56) UNIQUE,
  display_name        VARCHAR(100) NOT NULL,
  latitude            DECIMAL(10, 7) NOT NULL,
  longitude           DECIMAL(11, 7) NOT NULL,
  address_text        TEXT NOT NULL,
  hours_open          VARCHAR(5),
  hours_close         VARCHAR(5),
  base_rate           DECIMAL(12, 6),
  spread_percent      DECIMAL(7, 4),
  min_amount          DECIMAL(15, 2),
  max_amount          DECIMAL(15, 2),
  verification_status VARCHAR(10) NOT NULL DEFAULT 'pending',
  verified_at         TIMESTAMPTZ,
  type               VARCHAR(50),
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
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT merchants_user_unique UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS idx_merchants_user_id ON merchants(user_id);
CREATE INDEX IF NOT EXISTS idx_merchants_status  ON merchants(verification_status);
CREATE INDEX IF NOT EXISTS idx_merchants_location ON merchants(latitude, longitude);

-- Trades table (MXN Cash In/Out)
CREATE TABLE IF NOT EXISTS trades (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id         UUID REFERENCES users(id),
  buyer_id          UUID REFERENCES users(id),
  amount_mxn        DECIMAL(15, 2) NOT NULL,
  amount_stroops    VARCHAR(32) NOT NULL,
  platform_fee_mxn  DECIMAL(15, 2) NOT NULL,
  seller_fee_mxn    DECIMAL(15, 2),
  secret_hash       VARCHAR(64) NOT NULL,
  secret_enc        TEXT,
  secret_nonce      TEXT,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending',
  lock_tx_hash      VARCHAR(64),
  release_tx_hash   VARCHAR(64),
  expires_at        TIMESTAMPTZ NOT NULL,
  locked_at         TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_participants ON trades(seller_id, buyer_id);

-- Swap History table (Cross-chain Swaps)
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
);

-- Bazaar Intents table
CREATE TABLE IF NOT EXISTS bazaar_intents (
  id              VARCHAR(64) PRIMARY KEY,
  agent_address   VARCHAR(56) NOT NULL,
  offered_chain   VARCHAR(32) NOT NULL,
  offered_symbol  VARCHAR(16) NOT NULL,
  offered_amount  VARCHAR(32) NOT NULL,
  wanted_chain    VARCHAR(32) NOT NULL,
  wanted_symbol   VARCHAR(16) NOT NULL,
  wanted_amount   VARCHAR(32) NOT NULL,
  min_rate        DECIMAL(10, 6),
  status          VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  reputation_tier VARCHAR(20),
  secret_hash     VARCHAR(72),
  selected_quote_id VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS idx_bazaar_intents_status ON bazaar_intents(status);
CREATE INDEX IF NOT EXISTS idx_bazaar_intents_agent ON bazaar_intents(agent_address);

-- Bazaar Quotes table
CREATE TABLE IF NOT EXISTS bazaar_quotes (
  id          VARCHAR(64) PRIMARY KEY,
  intent_id   VARCHAR(64) NOT NULL REFERENCES bazaar_intents(id) ON DELETE CASCADE,
  from_agent  VARCHAR(56) NOT NULL,
  rate        DECIMAL(10, 6) NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bazaar_quotes_intent ON bazaar_quotes(intent_id);

-- Agent History table
CREATE TABLE IF NOT EXISTS agent_history (
  agent_address    VARCHAR(56) PRIMARY KEY,
  broadcasts       INTEGER NOT NULL DEFAULT 0,
  swaps_completed  INTEGER NOT NULL DEFAULT 0,
  swaps_cancelled  INTEGER NOT NULL DEFAULT 0,
  volume_usdc      DECIMAL(20, 2) NOT NULL DEFAULT 0,
  first_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- X402 Payments table
-- tx_hash is VARCHAR(120), not (64): a Base replay key is
-- "base:<0x-address>:<bytes32-nonce>" (~114 chars), wider than a bare
-- Stellar tx hash (64 hex chars). See db/x402.ts's initX402Tables() for the
-- ALTER TABLE that widens this on already-deployed databases.
CREATE TABLE IF NOT EXISTS x402_payments (
  tx_hash         VARCHAR(120) PRIMARY KEY,
  payer_address   VARCHAR(56) NOT NULL,
  amount_usdc     VARCHAR(32) NOT NULL,
  service         VARCHAR(64) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  used            BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_x402_payments_expires ON x402_payments(expires_at);
CREATE INDEX IF NOT EXISTS idx_x402_payments_payer ON x402_payments(payer_address);
