/**
 * Fusión monótona del swapStore.
 *
 * El store guarda un archivo por swap y, para el mismo swap, fusiona en vez de
 * sobrescribir. Es lo que hace que dos procesos —dos instancias detrás del
 * balanceador, o un script corriendo con la API levantada— no se pisen.
 *
 * La propiedad que hay que sostener: **este estado solo crece**. Las
 * transacciones se añaden y nunca se quitan; el status avanza y nunca
 * retrocede. Si una fusión pierde una tx, pierde la prueba de que unos fondos
 * se movieron.
 *
 * La prueba de los dos procesos de verdad es `npm run test:concurrency`.
 */

import { describe, it, expect } from "vitest";
import { fusionar, type SwapState } from "../lib/swapStore.js";

const base = (over: Partial<SwapState> = {}): SwapState => ({
  swap_id: "s1",
  plan_id: "p",
  status: "queued",
  sell_asset: "XLM",
  sell_amount: "1",
  buy_asset: "XRP",
  buy_amount: "2",
  chain_b: "xrpl",
  txs: {},
  created_at: "2026-08-07T10:00:00.000Z",
  updated_at: "2026-08-07T10:00:00.000Z",
  ...over,
});

describe("swapStore — fusión monótona", () => {
  it("sin versión previa devuelve la nueva tal cual", () => {
    const nuevo = base({ status: "locked_a" });
    expect(fusionar(null, nuevo)).toEqual(nuevo);
  });

  it("une las transacciones de las dos versiones", () => {
    // El caso real: un proceso solo vio el lock de Soroban, el otro ya vio la
    // pierna XRPL entera. Ninguno conoce lo del otro y los dos escriben.
    const p1 = base({ status: "locked_a", txs: { lock_a: "TX_A" } });
    const p2 = base({ status: "released_b", txs: { lock_b: "TX_B", release_b: "TX_REVEAL" } });

    const r = fusionar(p1, p2);

    expect(r.txs).toEqual({ lock_a: "TX_A", lock_b: "TX_B", release_b: "TX_REVEAL" });
  });

  it("el status avanza pero nunca retrocede", () => {
    const avanzado = base({ status: "completed" });
    const atrasado = base({ status: "locking_b" });

    expect(fusionar(avanzado, atrasado).status).toBe("completed");
    expect(fusionar(atrasado, avanzado).status).toBe("completed");
  });

  it("una escritura que no conoce un refund no lo borra", () => {
    // Borrar refund_b perdería la prueba de que unos fondos ya volvieron, y el
    // reintento periódico lo intentaría otra vez.
    const conRefund = base({ status: "refunded", txs: { lock_a: "A", lock_b: "B", refund_b: "REFUND" } });
    const sinRefund = base({ status: "refund_pending", txs: { lock_a: "A", lock_b: "B" } });

    const r = fusionar(conRefund, sinRefund);

    expect(r.txs.refund_b).toBe("REFUND");
    expect(r.status).toBe("refunded");
  });

  it("no pierde los datos del escrow XRPL ni el secret_hash", () => {
    // owner + offer_sequence es lo único con lo que se puede cancelar la
    // pierna B. Perderlo deja los fondos esperando al CancelAfter.
    const conEscrow = base({
      status: "locked_b",
      secret_hash: "aa".repeat(32),
      xrpl: { owner: "rOWNER", offer_sequence: 42, destination: "rDEST", condition: "A025…", cancel_after: 839_000_000 },
      txs: { lock_a: "A", lock_b: "B" },
    });
    const sinEscrow = base({ status: "refund_pending", txs: { lock_a: "A" } });

    const r = fusionar(conEscrow, sinEscrow);

    expect(r.xrpl?.owner).toBe("rOWNER");
    expect(r.xrpl?.offer_sequence).toBe(42);
    expect(r.secret_hash).toBe("aa".repeat(32));
  });

  it("created_at es el original y updated_at el más reciente", () => {
    const viejo = base({ created_at: "2026-08-07T10:00:00.000Z", updated_at: "2026-08-07T10:00:00.000Z" });
    const nuevo = base({ created_at: "2026-08-07T11:00:00.000Z", updated_at: "2026-08-07T11:00:00.000Z" });

    const r = fusionar(viejo, nuevo);

    expect(r.created_at).toBe("2026-08-07T10:00:00.000Z");
    expect(r.updated_at).toBe("2026-08-07T11:00:00.000Z");
  });

  it("fusionar es conmutativo en lo que importa: las dos órdenes convergen", () => {
    // Dos procesos no tienen orden garantizado. Si el resultado dependiera de
    // quién escribe último, seguiríamos teniendo el bug con otra cara.
    const p1 = base({ status: "locked_a", txs: { lock_a: "A" }, updated_at: "2026-08-07T10:00:00.000Z" });
    const p2 = base({ status: "released_b", txs: { lock_b: "B", release_b: "R" }, updated_at: "2026-08-07T10:00:01.000Z" });

    const ab = fusionar(p1, p2);
    const ba = fusionar(p2, p1);

    expect(ab.status).toBe(ba.status);
    expect(ab.txs).toEqual(ba.txs);
  });
});
