/**
 * Store de planes y estados de swap.
 * Compartido entre agent.ts (crear/ejecutar) y swaps.ts (polling de estado).
 */

import fs from "fs";

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
  | "failed"
  /** Falló con fondos ya bloqueados: hay que reembolsar las dos piernas. */
  | "refund_pending"
  | "refunded";

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

export const planStore = new Map<string, SwapPlan>();

/**
 * Estado de los swaps, persistido en disco.
 *
 * Era un `Map` en RAM, y eso convertía en mentira el comentario que dice que
 * los datos del escrow XRPL se guardan "antes de revelar, por si el proceso
 * muere": si el proceso moría, el Map moría con él y con él la única forma de
 * cancelar el escrow. Los fondos quedaban esperando al CancelAfter sin que
 * nadie supiera que existían.
 *
 * Escritura atómica (tmp + rename) y carga al arrancar. No es una base de
 * datos y no pretende serlo: es el mínimo para que un reinicio no pierda de
 * vista dinero bloqueado. `SWAP_STORE_PATH` lo desactiva si se pone vacío
 * (los tests corren así).
 */
const STORE_PATH = process.env.SWAP_STORE_PATH ?? "./swap-store.json";

class PersistentSwapStore extends Map<string, SwapState> {
  constructor() {
    super();
    if (!STORE_PATH) return;
    try {
      if (fs.existsSync(STORE_PATH)) {
        const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as Record<string, SwapState>;
        for (const [k, v] of Object.entries(raw)) super.set(k, v);
      }
    } catch (err) {
      console.warn(`[swapStore] estado ilegible, se arranca limpio: ${String(err)}`);
    }
  }

  override set(key: string, value: SwapState): this {
    super.set(key, value);
    this.flush();
    return this;
  }

  override delete(key: string): boolean {
    const had = super.delete(key);
    if (had) this.flush();
    return had;
  }

  private flush(): void {
    if (!STORE_PATH) return;
    try {
      const tmp = `${STORE_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this), null, 2));
      fs.renameSync(tmp, STORE_PATH);
    } catch (err) {
      // Que no se pueda escribir el estado NO debe tumbar un swap en curso,
      // pero tiene que verse: sin esto volvemos al caso de fondos perdidos.
      console.error(`[swapStore] NO SE PUDO PERSISTIR — un reinicio perderá este swap: ${String(err)}`);
    }
  }
}

export const swapStore: Map<string, SwapState> = new PersistentSwapStore();

/** Swaps que se quedaron a medias: tienen fondos bloqueados sin resolver. */
export function pendingRefunds(): SwapState[] {
  return [...swapStore.values()].filter(
    (s) => (s.status === "failed" || s.status === "refund_pending") && !!s.txs.lock_a && !s.txs.release_a && !s.txs.refund_a
  );
}
