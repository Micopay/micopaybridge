export type SwapStatus = "locked" | "released" | "refunded" | "expired";

export type RiskLevel = "low" | "medium" | "high";

export interface SwapStep {
  order: number;
  action: "lock" | "monitor" | "release" | "refund";
  chain: string;
  contract: "atomic_swap" | "micopay_escrow";
  params: Record<string, unknown>;
  depends_on?: number;
}

export interface SwapPlan {
  id: string;
  steps: SwapStep[];
  counterparty: {
    address: string;
    chain: string;
    /**
     * Lo emite el intent parser que ahora vive en archive/apps-agent/
     * (intent-parser.ts:152) y el prompt del sistema razona con él, pero el
     * tipo nunca lo declaró: el campo se producía y se tiraba. Opcional para
     * no romper a quien construya un SwapPlan sin reputación.
     */
    reputation_score?: number;
  };
  amounts: {
    sell_asset: string;
    sell_amount: string;
    buy_asset: string;
    buy_amount: string;
    exchange_rate: string;
  };
  timeouts: {
    initiator_ledgers: number;
    counterparty_ledgers: number;
  };
  fees: {
    gas_chain_a: string;
    gas_chain_b: string;
    service_fee: string;
    total_usd: string;
  };
  risk_level: RiskLevel;
  estimated_time_seconds: number;
}

export interface SwapResult {
  swap_id: string;
  status: SwapStatus | "completed" | "partial" | "failed";
  stellar_tx_hash?: string;
  chain_b_tx_hash?: string;
  error?: string;
  completed_at?: string;
}

export interface CounterpartyInfo {
  address: string;
  chain: string;
  /**
   * Sale de agent_history. null cuando esa direccion no tiene historial en
   * este mercado: un agente que decide si bloquear fondos contra un extraño
   * tiene que poder distinguir "sin historial" de un numero por defecto.
   */
  completion_rate: number | null;
  swaps_completed: number | null;
  avg_time_seconds: number | null;
  available_amount: string;
  /** "measured" si available_amount viene de algo real; "estimate" si no. */
  available_amount_source: "measured" | "estimate";
  rate: string;
  /** "demo" marca una contraparte sembrada, no un agente que se anuncio solo. */
  source: "demo" | "bazaar";
}
