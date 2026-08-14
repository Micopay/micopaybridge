#!/usr/bin/env node
/**
 * Smoke test del swap de dos piernas Soroban ↔ XRPL, contra MAINNET real.
 * Mueve fondos reales — por eso exige CONFIRM_MAINNET_SWAP=yes explícito y
 * nunca corre sin que alguien lea el plan impreso primero.
 *
 *   npm run test:live:mainnet -w @micopay/api
 *
 * A diferencia de live-swap.ts (testnet, wallets XRPL efímeras del faucet):
 *   - Pierna Soroban: self-swap con la MISMA identidad `mainnet-bridge` como
 *     initiator y counterparty. El contrato no exige que sean distintos
 *     (atomic-swap/src/lib.rs no tiene ese assert) — lock() saca el XLM de
 *     mainnet-bridge, release() se lo devuelve a la misma cuenta. Flujo neto
 *     de valor: cero, solo fees. Evita tener que fondear una segunda
 *     identidad Stellar en mainnet solo para este smoke test.
 *   - Pierna XRPL: SÍ son dos wallets reales y distintas (XRPL_INITIATOR_SEED /
 *     XRPL_COUNTERPARTY_SEED en .env) — el XRP se mueve de una a otra de
 *     verdad, ambas del propio Raúl, ver docs/RUNBOOK_MAINNET_DEPLOY.md.
 *
 * Requiere en apps/api/.env: XRPL_SERVER (mainnet), XRPL_INITIATOR_SEED,
 * XRPL_COUNTERPARTY_SEED (dos wallets XRPL mainnet fondeadas). Requiere en
 * apps/api/.env.mainnet-smoke: STELLAR_NETWORK=PUBLIC, STELLAR_RPC_URL,
 * ATOMIC_SWAP_CONTRACT_A. `stellar` CLI con la identidad `mainnet-bridge`
 * fondeada (STELLAR_INITIATOR_ALIAS/STELLAR_COUNTERPARTY_ALIAS para cambiarla).
 *
 * Las semillas no se imprimen nunca.
 */

import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { isValidClassicAddress } from "xrpl";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(relPath: string): void {
  const envPath = join(__dirname, "..", "..", relPath);
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i === -1) continue;
    process.env[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1).trim();
  }
}

// .env primero (seeds XRPL compartidas con el resto de la app), luego el
// overlay de mainnet encima — así este script nunca hereda RPC/contrato de
// testnet por accidente si alguien los deja puestos en .env.
loadEnvFile(".env");
loadEnvFile(".env.mainnet-smoke");

// Import DINÁMICO, a propósito: soroban.ts lee STELLAR_RPC_URL/STELLAR_NETWORK
// en su propio top-level al importarse. Un `import` estático se ejecuta antes
// que cualquier código de este archivo (hoisting de ES modules) — con eso,
// loadEnvFile() de arriba llegaría tarde y soroban.ts se quedaría con los
// defaults de testnet aunque .env.mainnet-smoke diga PUBLIC. Ya pasó una vez.
const { executeAtomicSwapBackground } = await import("../lib/soroban.js");
const { swapStore } = await import("../lib/swapStore.js");
const { xrplAddressFromSeed } = await import("../lib/xrpl-leg.js");

const CONTRACT_A = process.env.ATOMIC_SWAP_CONTRACT_A;
const XRPL_SERVER = process.env.XRPL_SERVER;
const XRPL_INITIATOR_SEED = process.env.XRPL_INITIATOR_SEED;
const XRPL_COUNTERPARTY_SEED = process.env.XRPL_COUNTERPARTY_SEED;
const STELLAR_ALIAS = process.env.STELLAR_INITIATOR_ALIAS ?? "mainnet-bridge";
const COUNTERPARTY_ALIAS = process.env.STELLAR_COUNTERPARTY_ALIAS ?? STELLAR_ALIAS;

const SELL_XLM = Number(process.env.SMOKE_SELL_XLM ?? "0.5");
const BUY_XRP = Number(process.env.SMOKE_BUY_XRP ?? "1");
const INITIATOR_LEDGERS = 240;
const COUNTERPARTY_LEDGERS = 120;

const stellarSecret = (alias: string): string =>
  execFileSync("stellar", ["keys", "show", alias], { encoding: "utf8" }).trim();

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    console.error(`Falta ${name} — revisa apps/api/.env y .env.mainnet-smoke`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  requireEnv("STELLAR_NETWORK=PUBLIC", process.env.STELLAR_NETWORK === "PUBLIC" ? "ok" : undefined);
  requireEnv("ATOMIC_SWAP_CONTRACT_A", CONTRACT_A);
  requireEnv("XRPL_SERVER", XRPL_SERVER);
  requireEnv("XRPL_INITIATOR_SEED", XRPL_INITIATOR_SEED);
  requireEnv("XRPL_COUNTERPARTY_SEED", XRPL_COUNTERPARTY_SEED);

  const xrplInitiatorAddr = xrplAddressFromSeed(XRPL_INITIATOR_SEED!);
  const xrplCounterpartyAddr = xrplAddressFromSeed(XRPL_COUNTERPARTY_SEED!);
  if (!isValidClassicAddress(xrplInitiatorAddr) || !isValidClassicAddress(xrplCounterpartyAddr)) {
    console.error("Las seeds XRPL no derivan direcciones válidas.");
    process.exit(1);
  }

  const stellarAddr = execFileSync("stellar", ["keys", "address", STELLAR_ALIAS], { encoding: "utf8" }).trim();

  console.log("=== SMOKE TEST MAINNET — lee esto antes de confirmar ===");
  console.log(`Red Soroban:        PUBLIC, RPC ${process.env.STELLAR_RPC_URL}`);
  console.log(`Contrato:           ${CONTRACT_A}`);
  console.log(`Cuenta Stellar:     ${stellarAddr} (alias ${STELLAR_ALIAS}) — self-swap, initiator = counterparty`);
  console.log(`Vende:              ${SELL_XLM} XLM (sale y vuelve a la misma cuenta)`);
  console.log(`Red XRPL:           ${XRPL_SERVER}`);
  console.log(`XRPL contraparte:   ${xrplCounterpartyAddr} (bloquea XRP de verdad)`);
  console.log(`XRPL iniciador:     ${xrplInitiatorAddr} (recibe ${BUY_XRP} XRP de verdad)`);
  console.log(`Compra:             ${BUY_XRP} XRP — este SÍ se mueve entre las dos wallets XRPL`);

  if (process.env.CONFIRM_MAINNET_SWAP !== "yes") {
    console.log("\nNo se ejecuta nada. Vuelve a correr con CONFIRM_MAINNET_SWAP=yes si el plan de arriba es correcto.");
    process.exit(0);
  }

  const swapId = `live_mainnet_${Date.now()}`;
  const now = new Date().toISOString();
  swapStore.set(swapId, {
    swap_id: swapId,
    plan_id: "live_mainnet",
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

  console.log("\n[run] lock A (Soroban) → lock B (XRPL) → reveal (XRPL) → release A (Soroban)");
  const t0 = Date.now();
  await executeAtomicSwapBackground(
    swapId,
    stellarSecret(STELLAR_ALIAS),
    stellarSecret(COUNTERPARTY_ALIAS),
    CONTRACT_A!,
    { initiatorSeed: XRPL_INITIATOR_SEED!, counterpartySeed: XRPL_COUNTERPARTY_SEED! },
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

  if (swap.status !== "completed") {
    console.log("\nNo completó — si algo quedó bloqueado, swapStore marca refund_pending. Revisar antes de reintentar.");
    process.exit(1);
  }
  console.log("\nSwap de dos piernas completo en MAINNET. Las cuatro txs son citables en stellar.expert / livenet.xrpl.org.");
  process.exit(0);
}

main().catch((err) => {
  console.error("FALLO:", err);
  process.exit(1);
});
