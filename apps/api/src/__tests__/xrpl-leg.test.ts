/**
 * Guardas de la orquestación con la pierna XRPL (M4.5).
 *
 * Todo offline: lo que se prueba aquí son los rechazos que ocurren ANTES de
 * tocar cualquier cadena. El camino feliz contra testnets reales es
 * `npm run test:live -w @micopaybridge/xrpl-bridge`, que tarda ~5 min y
 * necesita identidades fondeadas.
 */

import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import * as bt from "@micopaybridge/xrpl-bridge/bridge-translate";
import { executeAtomicSwapBackground } from "../lib/soroban.js";
import { recoverInFlightSwaps } from "../lib/recovery.js";
import { swapStore, pendingRefunds, TX_CHAIN, type SwapState } from "../lib/swapStore.js";

function seedSwap(swapId: string, buyAsset: string): void {
  const now = new Date().toISOString();
  swapStore.set(swapId, {
    swap_id: swapId,
    plan_id: "plan_test",
    status: "queued",
    sell_asset: "USDC",
    sell_amount: "1",
    buy_asset: buyAsset,
    buy_amount: "5",
    chain_b: "xrpl",
    txs: {},
    created_at: now,
    updated_at: now,
  });
}

const xrplLeg = { initiatorSeed: "sEdIGNORADA", counterpartySeed: "sEdIGNORADA" };

async function run(swapId: string, opts: { buyAsset: string; initiatorLedgers: number; counterpartyLedgers: number }) {
  seedSwap(swapId, opts.buyAsset);
  await executeAtomicSwapBackground(
    swapId,
    Keypair.random().secret(),
    Keypair.random().secret(),
    "CCDOUXIXSFXT2HTJAJGFNUJN6CKCYX2M6AL2BHHPEF6ISNHP2BGLS4KX",
    xrplLeg,
    "USDC",
    1,
    opts.buyAsset,
    5,
    opts.initiatorLedgers,
    opts.counterpartyLedgers,
  );
  return swapStore.get(swapId)!;
}

describe("pierna XRPL — guardas de la orquestación", () => {
  it("rechaza un buy_asset que no sea XRP antes de bloquear nada", async () => {
    const swap = await run("swap_no_xrp", { buyAsset: "XLM", initiatorLedgers: 240, counterpartyLedgers: 120 });

    expect(swap.status).toBe("failed");
    expect(swap.error).toContain("buy_asset debe ser XRP");
    // Lo que importa: no llegó a firmar nada.
    expect(swap.txs).toEqual({});
  });

  it("rechaza el swap si la pierna del iniciador no dura más que la de la contraparte", async () => {
    // El caso que el invariante existe para impedir: quien bloquea primero se
    // queda sin margen para reaccionar cuando el otro revela.
    const swap = await run("swap_invariante", { buyAsset: "XRP", initiatorLedgers: 120, counterpartyLedgers: 120 });

    expect(swap.status).toBe("failed");
    expect(swap.error).toContain("Invariante roto");
    expect(swap.txs).toEqual({});
  });

  it("rechaza una ventana de XRPL por debajo del piso, aunque el invariante pase", async () => {
    // REGRESIÓN. Con counterparty=1 ledger el invariante pasa (1200s > 5s) y
    // aun así el swap muere: verificado contra testnet el 2026-08-07, la
    // ventana de 5s se cerró antes del EscrowFinish (tecNO_PERMISSION) y dejó
    // 0.1 XLM bloqueados en Soroban. Comprobar solo el invariante no basta.
    expect(bt.checkInvariant(240 * 5, 1 * 5)).toBe(true);

    const swap = await run("swap_sin_piso", { buyAsset: "XRP", initiatorLedgers: 240, counterpartyLedgers: 1 });

    expect(swap.status).toBe("failed");
    expect(swap.error).toContain("demasiado corto");
    expect(swap.txs).toEqual({});
  });

  it("el piso de XRPL sale del mismo mínimo que exige el contrato de Soroban", () => {
    expect(bt.MIN_COUNTERPARTY_TIMEOUT_SEC).toBe(bt.MIN_TIMEOUT_LEDGERS * bt.STELLAR_SECONDS_PER_LEDGER);
    expect(() => bt.assertTimeoutsSafe(1200, bt.MIN_COUNTERPARTY_TIMEOUT_SEC)).not.toThrow();
    expect(() => bt.assertTimeoutsSafe(1200, bt.MIN_COUNTERPARTY_TIMEOUT_SEC - 1)).toThrow(/demasiado corto/);
  });

  it("un fallo con fondos ya bloqueados queda como refund_pending, no como failed", async () => {
    // failed suena a "no pasó nada". Si hay un lock, hay dinero parado y
    // alguien tiene que devolverlo: el estado tiene que decirlo para que
    // pendingRefunds() lo encuentre.
    const swapId = "swap_con_lock";
    seedSwap(swapId, "XRP");
    swapStore.set(swapId, {
      ...swapStore.get(swapId)!,
      secret_hash: "aa".repeat(32),
      txs: { lock_a: "hash_falso_de_lock" },
    });

    await executeAtomicSwapBackground(
      swapId,
      Keypair.random().secret(),
      Keypair.random().secret(),
      "CCDOUXIXSFXT2HTJAJGFNUJN6CKCYX2M6AL2BHHPEF6ISNHP2BGLS4KX",
      xrplLeg,
      "USDC", 1, "XLM", 5,   // buy_asset inválido → falla con el lock ya puesto
      240, 120,
    );

    const swap = swapStore.get(swapId)!;
    expect(swap.status).toBe("refund_pending");
    expect(pendingRefunds().map((s) => s.swap_id)).toContain(swapId);
  });

  it("el invariante se comprueba en reloj de pared, no en unidades nativas", () => {
    // 240 ledgers de Stellar son 1200 s; el CancelAfter de la contraparte se
    // deriva del mismo margen. Comparar los números crudos de cada cadena
    // (240 contra un timestamp de época Ripple) no significa nada.
    const initiatorSec = 240 * bt.STELLAR_SECONDS_PER_LEDGER;
    const counterpartySec = 120 * bt.STELLAR_SECONDS_PER_LEDGER;

    expect(bt.checkInvariant(initiatorSec, counterpartySec)).toBe(true);
    expect(bt.checkInvariant(counterpartySec, initiatorSec)).toBe(false);
  });

  it("una sola preimagen gobierna las dos piernas", () => {
    // La condition de XRPL no se genera aparte: su fingerprint ES el
    // secret_hash que valida Soroban. Si se generaran por separado, serían dos
    // escrows sin relación y el swap no sería atómico.
    const preimage = bt.generatePreimage();
    const sorobanHash = bt.sorobanSecretHash(preimage);
    const condition = bt.xrplCondition(preimage);

    expect(condition.slice(8, 8 + 64)).toBe(sorobanHash.toString("hex").toUpperCase());
    expect(bt.xrplConditionFromHash(sorobanHash)).toBe(condition);
  });

  it("recuperación: un swap sin nada bloqueado no se marca para reembolso", async () => {
    // Si no se llegó a firmar nada, no hay dinero que devolver. Marcarlo
    // refund_pending metería ruido en la cola que un operador tiene que
    // mirar, que es justo donde no se puede meter ruido.
    const swapId = "swap_sin_locks";
    seedSwap(swapId, "XRP");

    const report = await recoverInFlightSwaps({
      initiatorSecret: Keypair.random().secret(),
      counterpartySecret: Keypair.random().secret(),
      contractA: "CCDOUXIXSFXT2HTJAJGFNUJN6CKCYX2M6AL2BHHPEF6ISNHP2BGLS4KX",
      xrplLeg,
    });

    expect(report.revisados).toBeGreaterThan(0);
    expect(swapStore.get(swapId)!.status).toBe("queued");
    expect(pendingRefunds().map((s) => s.swap_id)).not.toContain(swapId);
  });

  it("cada tx sabe en qué cadena vive, para no enlazar al explorador equivocado", () => {
    const keys: (keyof SwapState["txs"])[] = ["lock_a", "release_a", "refund_a", "lock_b", "release_b", "refund_b"];
    for (const k of keys) expect(TX_CHAIN[k]).toBeDefined();

    expect(TX_CHAIN.lock_a).toBe("stellar");
    expect(TX_CHAIN.release_a).toBe("stellar");
    expect(TX_CHAIN.lock_b).toBe("xrpl");
    expect(TX_CHAIN.release_b).toBe("xrpl");
  });
});
