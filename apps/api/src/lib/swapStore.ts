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

/**
 * Datos de la pierna XRPL. `owner` + `offer_sequence` es lo que identifica un
 * escrow en XRPL: sin los dos no se puede ni completar ni cancelar, así que
 * se guardan en cuanto existen — si el proceso muere entre el lock y la
 * revelación, es lo único que permite recuperar o reembolsar la pierna.
 */
export interface XrplLegState {
  owner: string;
  offer_sequence: number;
  destination: string;
  condition: string;
  /** CancelAfter en época Ripple (segundos desde 2000-01-01, no Unix). */
  cancel_after: number;
}

export interface SwapState {
  swap_id: string;
  plan_id: string;
  status: SwapStatus;
  sell_asset: string;
  sell_amount: string;
  buy_asset: string;
  buy_amount: string;
  secret_hash?: string;
  /** Cadena de la pierna B. Antes de M4.5 era otra instancia de Soroban. */
  chain_b: "xrpl";
  xrpl?: XrplLegState;
  txs: {
    /** Soroban */
    lock_a?: string;
    release_a?: string;
    refund_a?: string;
    /** XRPL */
    lock_b?: string;
    release_b?: string;
    refund_b?: string;
  };
  error?: string;
  created_at: string;
  updated_at: string;
}

/** En qué cadena vive cada tx del store. Los exploradores no son el mismo. */
export const TX_CHAIN: Record<keyof SwapState["txs"], "stellar" | "xrpl"> = {
  lock_a: "stellar",
  release_a: "stellar",
  refund_a: "stellar",
  lock_b: "xrpl",
  release_b: "xrpl",
  refund_b: "xrpl",
};

export const planStore  = new Map<string, SwapPlan>();
export const swapStore  = new Map<string, SwapState>();
