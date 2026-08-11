#!/usr/bin/env node
/**
 * Swap de dos piernas Soroban ↔ XRPL contra testnets reales.
 *
 *   npm run test:live -w @micopay/api
 *
 * Llama directo a la orquestación en vez de pasar por HTTP: /api/v1/swaps/plan
 * necesita ANTHROPIC_API_KEY para construir el plan, y lo que se quiere probar
 * aquí es el swap, no el parser de intención.
 *
 * Requiere:
 *   - `stellar` CLI con dos identidades fondeadas en testnet. Por defecto
 *     `raul-bridge` y `mota-agent`; se cambian con STELLAR_INITIATOR_ALIAS y
 *     STELLAR_COUNTERPARTY_ALIAS.
 *   - ATOMIC_SWAP_CONTRACT_A desplegado en Soroban testnet.
 *   - Nada de XRPL: las dos wallets salen del faucet en cada corrida.
 *
 * Las semillas no se imprimen nunca. Las de XRPL son efímeras del faucet.
 */

import { execFileSync } from "child_process";
import { Client } from "xrpl";
import { executeAtomicSwapBackground } from "../lib/soroban.js";
import { swapStore } from "../lib/swapStore.js";

const CONTRACT_A = process.env.ATOMIC_SWAP_CONTRACT_A ?? "CANNVHGZHVSVQO76SIVV5YNHH6ODDBV5IEROUITFTFIH6NRLF7XHRCIT";
const INITIATOR_ALIAS = process.env.STELLAR_INITIATOR_ALIAS ?? "raul-bridge";
const COUNTERPARTY_ALIAS = process.env.STELLAR_COUNTERPARTY_ALIAS ?? "mota-agent";

const SELL_XLM = 0.1;
const BUY_XRP = 2;
// 240 ledgers ≈ 1200 s para el iniciador, 120 ≈ 600 s para la contraparte.
// La mitad, para que el invariante se cumpla por construcción.
const INITIATOR_LEDGERS = 240;
const COUNTERPARTY_LEDGERS = 120;

const stellarSecret = (alias: string): string =>
  execFileSync("stellar", ["keys", "show", alias], { encoding: "utf8" }).trim();

async function main(): Promise<void> {
  console.log("[setup] fondeando dos wallets XRPL en el faucet de testnet…");
  const client = new Client(process.env.XRPL_SERVER ?? "wss://s.altnet.rippletest.net:51233");
  await client.connect();
  const { wallet: counterparty } = await client.fundWallet();
  const { wallet: initiator } = await client.fundWallet();
  await client.disconnect();
  console.log(`[setup] contraparte XRPL (bloquea)  ${counterparty.address}`);
  console.log(`[setup] iniciador XRPL (revela)     ${initiator.address}`);

  const swapId = `live_${Date.now()}`;
  const now = new Date().toISOString();
  swapStore.set(swapId, {
    swap_id: swapId,
    plan_id: "live",
    status: "queued",
    sell_asset: "XLM",
    sell_amount: String(SELL_XLM),
    buy_asset: "XRP",
    buy_amount: String(BUY_XRP),
    chain_b: "xrpl",
    txs: {},
    created_at: now,
    updated_at: now,
  });

  console.log("[run] lock A (Soroban) → lock B (XRPL) → reveal (XRPL) → release A (Soroban)");
  const t0 = Date.now();
  await executeAtomicSwapBackground(
    swapId,
    stellarSecret(INITIATOR_ALIAS),
    stellarSecret(COUNTERPARTY_ALIAS),
    CONTRACT_A,
    { initiatorSeed: initiator.seed!, counterpartySeed: counterparty.seed! },
    "XLM",
    SELL_XLM,
    "XRP",
    BUY_XRP,
    INITIATOR_LEDGERS,
    COUNTERPARTY_LEDGERS,
  );

  const swap = swapStore.get(swapId)!;
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n=== ${swap.status} en ${secs}s ===`);
  if (swap.error) console.log("error:", swap.error);
  console.log("secret_hash:", swap.secret_hash);
  console.log("escrow XRPL:", JSON.stringify(swap.xrpl));
  console.log("txs:", JSON.stringify(swap.txs, null, 2));

  if (swap.status !== "completed") process.exit(1);
  console.log("\nSwap de dos piernas completo. Las cuatro txs son citables en sus exploradores.");
  process.exit(0);
}

main().catch((err) => {
  console.error("FALLO:", err);
  process.exit(1);
});
