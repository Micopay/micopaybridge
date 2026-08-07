import { query, getOne, getMany } from './schema.js';

export interface BazaarIntentRow {
  id: string;
  agent_address: string;
  offered_chain: string;
  offered_symbol: string;
  offered_amount: string;
  wanted_chain: string;
  wanted_symbol: string;
  wanted_amount: string;
  min_rate: number | null;
  status: 'active' | 'negotiating' | 'executed' | 'expired';
  created_at: string;
  expires_at: string;
  reputation_tier: string | null;
  secret_hash: string | null;
  selected_quote_id: string | null;
}

export interface BazaarQuoteRow {
  id: string;
  intent_id: string;
  from_agent: string;
  rate: number;
  valid_until: string;
  created_at: string;
}

export interface AgentHistoryRow {
  agent_address: string;
  broadcasts: number;
  swaps_completed: number;
  swaps_cancelled: number;
  volume_usdc: number;
  first_seen: string;
  last_active: string;
}

export async function initBazaarTables(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS bazaar_intents (
      id              VARCHAR(64) PRIMARY KEY,
      agent_address   VARCHAR(56) NOT NULL,
      offered_chain   VARCHAR(32) NOT NULL,
      offered_symbol  VARCHAR(16) NOT NULL,
      offered_amount  VARCHAR(32) NOT NULL,
      wanted_chain    VARCHAR(32) NOT NULL,
      wanted_symbol   VARCHAR(16) NOT NULL,
      wanted_amount   VARCHAR(32) NOT NULL,
      min_rate        DECIMAL(5,4),
      status          VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at      TIMESTAMPTZ NOT NULL,
      reputation_tier VARCHAR(20),
      secret_hash     VARCHAR(72),
      selected_quote_id VARCHAR(64),
      CONSTRAINT bazaar_intents_status_check CHECK (status IN ('active', 'negotiating', 'executed', 'expired'))
    );

    CREATE INDEX IF NOT EXISTS idx_bazaar_intents_status ON bazaar_intents(status);
    CREATE INDEX IF NOT EXISTS idx_bazaar_intents_agent ON bazaar_intents(agent_address);
    CREATE INDEX IF NOT EXISTS idx_bazaar_intents_created ON bazaar_intents(created_at DESC);
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS bazaar_quotes (
      id          VARCHAR(64) PRIMARY KEY,
      intent_id   VARCHAR(64) NOT NULL REFERENCES bazaar_intents(id) ON DELETE CASCADE,
      from_agent  VARCHAR(56) NOT NULL,
      rate        DECIMAL(10,6) NOT NULL,
      valid_until TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_bazaar_quotes_intent ON bazaar_quotes(intent_id);
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS agent_history (
      agent_address    VARCHAR(56) PRIMARY KEY,
      broadcasts       INTEGER NOT NULL DEFAULT 0,
      swaps_completed  INTEGER NOT NULL DEFAULT 0,
      swaps_cancelled  INTEGER NOT NULL DEFAULT 0,
      volume_usdc      DECIMAL(20,2) NOT NULL DEFAULT 0,
      first_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_active      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

export async function createIntent(intent: Omit<BazaarIntentRow, 'created_at'>): Promise<BazaarIntentRow> {
  await query(`
    INSERT INTO bazaar_intents (
      id, agent_address, offered_chain, offered_symbol, offered_amount,
      wanted_chain, wanted_symbol, wanted_amount, min_rate, status,
      expires_at, reputation_tier
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  `, [
    intent.id, intent.agent_address, intent.offered_chain, intent.offered_symbol,
    intent.offered_amount, intent.wanted_chain, intent.wanted_symbol,
    intent.wanted_amount, intent.min_rate, intent.status, intent.expires_at,
    intent.reputation_tier
  ]);
  const result = await getOne<BazaarIntentRow>('SELECT * FROM bazaar_intents WHERE id = $1', [intent.id]);
  return result as BazaarIntentRow;
}

export async function getIntent(id: string): Promise<BazaarIntentRow | null> {
  return getOne<BazaarIntentRow>('SELECT * FROM bazaar_intents WHERE id = $1', [id]);
}

export async function getActiveIntents(): Promise<BazaarIntentRow[]> {
  return getMany<BazaarIntentRow>(`
    SELECT * FROM bazaar_intents
    WHERE status = 'active'
    ORDER BY created_at DESC
  `);
}

export async function updateIntent(
  id: string,
  updates: Partial<Pick<BazaarIntentRow, 'status' | 'secret_hash' | 'selected_quote_id'>>
): Promise<BazaarIntentRow | null> {
  const sets: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (updates.status !== undefined) {
    sets.push(`status = $${idx++}`);
    values.push(updates.status);
  }
  if (updates.secret_hash !== undefined) {
    sets.push(`secret_hash = $${idx++}`);
    values.push(updates.secret_hash);
  }
  if (updates.selected_quote_id !== undefined) {
    sets.push(`selected_quote_id = $${idx++}`);
    values.push(updates.selected_quote_id);
  }

  if (sets.length === 0) return getIntent(id);

  values.push(id);
  await query(`UPDATE bazaar_intents SET ${sets.join(', ')} WHERE id = $${idx}`, values);
  return getIntent(id);
}

export async function createQuote(quote: Omit<BazaarQuoteRow, 'created_at'>): Promise<BazaarQuoteRow> {
  await query(`
    INSERT INTO bazaar_quotes (id, intent_id, from_agent, rate, valid_until)
    VALUES ($1, $2, $3, $4, $5)
  `, [quote.id, quote.intent_id, quote.from_agent, quote.rate, quote.valid_until]);
  const result = await getOne<BazaarQuoteRow>('SELECT * FROM bazaar_quotes WHERE id = $1', [quote.id]);
  return result as BazaarQuoteRow;
}

export async function getQuotesForIntent(intentId: string): Promise<BazaarQuoteRow[]> {
  return getMany<BazaarQuoteRow>(
    'SELECT * FROM bazaar_quotes WHERE intent_id = $1 ORDER BY created_at DESC',
    [intentId]
  );
}

export async function getAgentHistory(address: string): Promise<AgentHistoryRow | null> {
  return getOne<AgentHistoryRow>('SELECT * FROM agent_history WHERE agent_address = $1', [address]);
}

export async function upsertAgentHistory(
  address: string,
  updates: Partial<Omit<AgentHistoryRow, 'agent_address'>>
): Promise<AgentHistoryRow> {
  const existing = await getAgentHistory(address);

  if (!existing) {
    await query(`
      INSERT INTO agent_history (agent_address, broadcasts, swaps_completed, swaps_cancelled, volume_usdc)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      address,
      updates.broadcasts ?? 1,
      updates.swaps_completed ?? 0,
      updates.swaps_cancelled ?? 0,
      updates.volume_usdc ?? 0
    ]);
    const result = await getAgentHistory(address);
    return result as AgentHistoryRow;
  } else {
    const sets: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (updates.broadcasts !== undefined) {
      sets.push(`broadcasts = $${idx++}`);
      values.push(existing.broadcasts + updates.broadcasts);
    }
    if (updates.swaps_completed !== undefined) {
      sets.push(`swaps_completed = $${idx++}`);
      values.push(existing.swaps_completed + updates.swaps_completed);
    }
    if (updates.swaps_cancelled !== undefined) {
      sets.push(`swaps_cancelled = $${idx++}`);
      values.push(existing.swaps_cancelled + updates.swaps_cancelled);
    }
    if (updates.volume_usdc !== undefined) {
      sets.push(`volume_usdc = $${idx++}`);
      values.push(existing.volume_usdc + updates.volume_usdc);
    }

    if (sets.length > 0) {
      sets.push('last_active = NOW()');
      values.push(address);
      await query(`UPDATE agent_history SET ${sets.join(', ')} WHERE agent_address = $${idx}`, values);
    }
    const result = await getAgentHistory(address);
    return result as AgentHistoryRow;
  }
}

export async function seedAgentHistories(): Promise<void> {
  const agents = [
    {
      address: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKUJI5KOOJ9TXWNTBBS2JN',
      broadcasts: 87, swaps_completed: 83, swaps_cancelled: 4, volume_usdc: 241500
    },
    {
      address: 'GDAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A',
      broadcasts: 31, swaps_completed: 28, swaps_cancelled: 3, volume_usdc: 52300
    },
  ];

  for (const agent of agents) {
    await query(`
      INSERT INTO agent_history (agent_address, broadcasts, swaps_completed, swaps_cancelled, volume_usdc)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (agent_address) DO NOTHING
    `, [agent.address, agent.broadcasts, agent.swaps_completed, agent.swaps_cancelled, agent.volume_usdc]);
  }
}

export async function seedIntents(): Promise<void> {
  const now = new Date();
  const intents = [
    {
      id: 'int-001',
      agent_address: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKUJI5KOOJ9TXWNTBBS2JN',
      offered_chain: 'ethereum', offered_symbol: 'ETH', offered_amount: '2.5',
      wanted_chain: 'stellar', wanted_symbol: 'USDC', wanted_amount: '7000',
      status: 'active',
      expires_at: new Date(now.getTime() + 55 * 60 * 1000).toISOString(),
      reputation_tier: 'maestro'
    },
    {
      id: 'int-002',
      agent_address: 'GDAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A',
      offered_chain: 'stellar', offered_symbol: 'USDC', offered_amount: '500',
      wanted_chain: 'physical', wanted_symbol: 'MXN', wanted_amount: '8750',
      status: 'active',
      expires_at: new Date(now.getTime() + 58 * 60 * 1000).toISOString(),
      reputation_tier: 'experto'
    },
  ];

  for (const intent of intents) {
    await query(`
      INSERT INTO bazaar_intents (
        id, agent_address, offered_chain, offered_symbol, offered_amount,
        wanted_chain, wanted_symbol, wanted_amount, status, expires_at, reputation_tier,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (id) DO NOTHING
    `, [
      intent.id, intent.agent_address, intent.offered_chain, intent.offered_symbol,
      intent.offered_amount, intent.wanted_chain, intent.wanted_symbol,
      intent.wanted_amount, intent.status, intent.expires_at, intent.reputation_tier,
      new Date(now.getTime() - 5 * 60 * 1000).toISOString()
    ]);
  }
}

export function intentRowToObject(row: BazaarIntentRow) {
  return {
    id: row.id,
    agent_address: row.agent_address,
    offered: { chain: row.offered_chain, symbol: row.offered_symbol, amount: row.offered_amount },
    wanted: { chain: row.wanted_chain, symbol: row.wanted_symbol, amount: row.wanted_amount },
    min_rate: row.min_rate,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
    reputation_tier: row.reputation_tier,
    secret_hash: row.secret_hash,
    selected_quote_id: row.selected_quote_id,
  };
}

export interface BazaarStats {
  total_intents: number;
  active_intents: number;
  negotiating_intents: number;
  executed_intents: number;
  expired_intents: number;
  total_volume_usdc: number;
  total_broadcasts: number;
  total_swaps_completed: number;
  total_swaps_cancelled: number;
  top_agents: AgentStats[];
  recent_intents: ReturnType<typeof intentRowToObject>[];
}

export interface AgentStats {
  agent_address: string;
  broadcasts: number;
  swaps_completed: number;
  completion_rate: number;
  volume_usdc: number;
  tier: string;
  tier_emoji: string;
}

export async function getBazaarStats(): Promise<BazaarStats> {
  const statusCounts = await getMany<{ status: string; count: string }>(`
    SELECT status, COUNT(*) as count FROM bazaar_intents GROUP BY status
  `);

  const agentStats = await getMany<AgentHistoryRow>(`
    SELECT * FROM agent_history ORDER BY swaps_completed DESC LIMIT 10
  `);

  const recentIntents = await getMany<BazaarIntentRow>(`
    SELECT * FROM bazaar_intents ORDER BY created_at DESC LIMIT 10
  `);

  const volumeResult = await getOne<{ total: string }>(`
    SELECT COALESCE(SUM(volume_usdc), 0) as total FROM agent_history
  `);

  const totalIntents = statusCounts.reduce((sum, row) => sum + parseInt(row.count, 10), 0);
  const activeIntents = parseInt(statusCounts.find(r => r.status === "active")?.count ?? "0", 10);
  const negotiatingIntents = parseInt(statusCounts.find(r => r.status === "negotiating")?.count ?? "0", 10);
  const executedIntents = parseInt(statusCounts.find(r => r.status === "executed")?.count ?? "0", 10);
  const expiredIntents = parseInt(statusCounts.find(r => r.status === "expired")?.count ?? "0", 10);

  const topAgents: AgentStats[] = agentStats.map(agent => {
    const rate = agent.broadcasts > 0 ? agent.swaps_completed / agent.broadcasts : 0;
    const tier = getAgentTierStatic(agent.swaps_completed, agent.broadcasts);
    return {
      agent_address: agent.agent_address,
      broadcasts: agent.broadcasts,
      swaps_completed: agent.swaps_completed,
      completion_rate: parseFloat(rate.toFixed(3)),
      volume_usdc: agent.volume_usdc,
      tier: tier.name,
      tier_emoji: tier.emoji,
    };
  });

  return {
    total_intents: totalIntents,
    active_intents: activeIntents,
    negotiating_intents: negotiatingIntents,
    executed_intents: executedIntents,
    expired_intents: expiredIntents,
    total_volume_usdc: parseFloat(volumeResult?.total ?? "0"),
    total_broadcasts: agentStats.reduce((sum, a) => sum + a.broadcasts, 0),
    total_swaps_completed: agentStats.reduce((sum, a) => sum + a.swaps_completed, 0),
    total_swaps_cancelled: agentStats.reduce((sum, a) => sum + a.swaps_cancelled, 0),
    top_agents: topAgents,
    recent_intents: recentIntents.map(intentRowToObject),
  };
}

function getAgentTierStatic(completed: number, total: number) {
  const rate = total > 0 ? completed / total : 0;
  return AGENT_TIERS.find(t => completed >= t.min_swaps && rate >= t.min_rate)
    ?? AGENT_TIERS[AGENT_TIERS.length - 1];
}

const AGENT_TIERS = [
  { name: "maestro",  emoji: "🍄", min_swaps: 50,  min_rate: 0.95 },
  { name: "experto",  emoji: "⭐", min_swaps: 15,  min_rate: 0.88 },
  { name: "activo",   emoji: "✅", min_swaps: 3,   min_rate: 0.75 },
  { name: "espora",   emoji: "🌱", min_swaps: 0,   min_rate: 0.0  },
];
