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
    completion_rate: number;
    avg_time_seconds: number;
    available_amount: string;
    rate: string;
}
//# sourceMappingURL=swap.d.ts.map