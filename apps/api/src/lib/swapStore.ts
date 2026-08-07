/**
 * In-memory store for swap plans and live swap states.
 * Shared between agent.ts (create/execute) and swaps.ts (status polling).
 */

export interface SwapPlan {
  id: string;
  sell_asset: string;
  sell_amount: string;
  buy_asset: string;
  buy_amount: string;
  exchange_rate: string;
  initiator_ledgers: number;
  counterparty_ledgers: number;
  risk_level: string;
  estimated_time_seconds: number;
  created_at: string;
}

export type SwapStatus =
  | "queued"
  | "locking_a"
  | "locked_a"
  | "locking_b"
  | "locked_b"
  | "releasing_b"
  | "released_b"
  | "releasing_a"
  | "completed"
  | "failed";

export interface SwapState {
  swap_id: string;
  plan_id: string;
  status: SwapStatus;
  sell_asset: string;
  sell_amount: string;
  buy_asset: string;
  buy_amount: string;
  secret_hash?: string;
  txs: {
    lock_a?: string;
    lock_b?: string;
    release_b?: string;
    release_a?: string;
  };
  error?: string;
  created_at: string;
  updated_at: string;
}

export const planStore  = new Map<string, SwapPlan>();
export const swapStore  = new Map<string, SwapState>();
