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
import { swapStore, TX_CHAIN, type SwapState } from "../lib/swapStore.js";

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

  it("cada tx sabe en qué cadena vive, para no enlazar al explorador equivocado", () => {
    const keys: (keyof SwapState["txs"])[] = ["lock_a", "release_a", "refund_a", "lock_b", "release_b", "refund_b"];
    for (const k of keys) expect(TX_CHAIN[k]).toBeDefined();

    expect(TX_CHAIN.lock_a).toBe("stellar");
    expect(TX_CHAIN.release_a).toBe("stellar");
    expect(TX_CHAIN.lock_b).toBe("xrpl");
    expect(TX_CHAIN.release_b).toBe("xrpl");
  });
});
