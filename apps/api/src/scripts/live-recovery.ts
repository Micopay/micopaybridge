#!/usr/bin/env node
/**
 * Recuperación tras crash, contra testnets reales.
 *
 *   npm run test:recovery -w @micopay/api
 *
 * Reproduce el peor momento para morirse: justo DESPUÉS de revelar la
 * preimagen en XRPL y ANTES de cobrar la pierna de Soroban. En ese punto el
 * iniciador ya se llevó el XRP y la contraparte todavía no ha cobrado su XLM.
 *
 * La simulación es fiel en lo que importa: **la preimagen se descarta**. No se
 * pasa a la recuperación por ningún lado. Si el swap se completa, es porque la
 * sacó del ledger de XRPL, que es lo único que sobrevive a un `kill -9`.
 */

import { execFileSync } from "child_process";
import { Client } from "xrpl";
import * as bt from "@micopaybridge/xrpl-bridge/bridge-translate";
import { lockXrplLeg, revealOnXrpl, xrplAddressFromSeed } from "../lib/xrpl-leg.js";
import { swapStore } from "../lib/swapStore.js";
import { recoverInFlightSwaps } from "../lib/recovery.js";

const CONTRACT_A = process.env.ATOMIC_SWAP_CONTRACT_A ?? "CANNVHGZHVSVQO76SIVV5YNHH6ODDBV5IEROUITFTFIH6NRLF7XHRCIT";
const NATIVE_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const A = process.env.STELLAR_INITIATOR_ALIAS ?? "raul-bridge";
const B = process.env.STELLAR_COUNTERPARTY_ALIAS ?? "mota-agent";

/** `--network` va ANTES del `--`; después, el CLI lo toma como argumento del contrato. */
const cli = (...args: string[]) => {
  const sep = args.indexOf("--");
  const full = sep === -1
    ? [...args, "--network", "testnet"]
    : [...args.slice(0, sep), "--network", "testnet", ...args.slice(sep)];
  return execFileSync("stellar", full, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
};
const secret = (alias: string) => execFileSync("stellar", ["keys", "show", alias], { encoding: "utf8" }).trim();
const address = (alias: string) => execFileSync("stellar", ["keys", "address", alias], { encoding: "utf8" }).trim();

async function main(): Promise<void> {
  const client = new Client(process.env.XRPL_SERVER ?? "wss://s.altnet.rippletest.net:51233");
  await client.connect();
  const { wallet: counterparty } = await client.fundWallet();
  const { wallet: initiator } = await client.fundWallet();
  await client.disconnect();

  const swapId = `crash_${Date.now()}`;
  const now = new Date().toISOString();

  // ── Pasos 1 a 3, como los haría el flujo normal ──────────────────────────
  const preimage = bt.generatePreimage();
  const secretHash = bt.sorobanSecretHash(preimage);
  console.log(`[1/3] lock en Soroban  secret_hash=${secretHash.toString("hex").slice(0, 16)}…`);
  const lockA = cli(
    "contract", "invoke", "--id", CONTRACT_A, "--source", A, "--",
    "lock", "--initiator", address(A), "--counterparty", address(B),
    "--token", NATIVE_SAC, "--amount", "1000000",
    "--secret_hash", secretHash.toString("hex"),
    "--timeout_ledgers", "240",
  );
  console.log(`      swap on-chain: ${JSON.parse(lockA)}`);

  console.log("[2/3] EscrowCreate en XRPL");
  const escrow = await lockXrplLeg({
    counterpartySeed: counterparty.seed!,
    destinationAddress: xrplAddressFromSeed(initiator.seed!),
    amountXrp: "2",
    secretHash,
    cancelAfterUnix: Math.floor(Date.now() / 1000) + 600,
  });

  console.log("[3/3] EscrowFinish — la preimagen queda pública en el ledger");
  const revealed = await revealOnXrpl({
    initiatorSeed: initiator.seed!,
    owner: escrow.owner,
    offerSequence: escrow.offerSequence,
    preimage,
  });

  // ── kill -9 aquí ─────────────────────────────────────────────────────────
  swapStore.set(swapId, {
    swap_id: swapId, plan_id: "crash", status: "released_b",
    sell_asset: "XLM", sell_amount: "0.1", buy_asset: "XRP", buy_amount: "2",
    chain_b: "xrpl",
    secret_hash: secretHash.toString("hex"),
    xrpl: {
      owner: escrow.owner, offer_sequence: escrow.offerSequence,
      destination: escrow.destination, condition: escrow.condition,
      cancel_after: escrow.cancelAfter,
    },
    // El CLI devuelve el swap_id del contrato, no el hash de la transacción.
    // Para la recuperación da igual: lo que mira es que lock_a exista.
    txs: { lock_a: `soroban:${JSON.parse(lockA)}`, lock_b: escrow.hash, release_b: revealed.hash },
    created_at: now, updated_at: now,
  });

  console.log("\n=== CRASH: el proceso muere aquí. La preimagen se descarta. ===");
  const preimageOlvidada = preimage.toString("hex");
  console.log(`(solo para comprobar al final: ${preimageOlvidada.slice(0, 16)}…)`);

  // ── Arranque nuevo: recuperar ────────────────────────────────────────────
  console.log("\n[reinicio] revisando swaps a medias contra las cadenas…");
  const report = await recoverInFlightSwaps({
    initiatorSecret: secret(A),
    counterpartySecret: secret(B),
    contractA: CONTRACT_A,
    xrplLeg: { initiatorSeed: initiator.seed!, counterpartySeed: counterparty.seed! },
  });

  const final = swapStore.get(swapId)!;
  console.log(`\nestado final: ${final.status}`);
  console.log(`release_a:    ${final.txs.release_a}`);
  console.log(`completados:  ${JSON.stringify(report.completados)}`);

  const onChain = cli("contract", "invoke", "--id", CONTRACT_A, "--source", A, "--", "get_status", "--swap_id", JSON.parse(lockA));
  console.log(`estado on-chain: ${onChain}`);

  const ok = final.status === "completed" && onChain.includes("Released");
  console.log(ok
    ? "\nRECUPERADO: la preimagen se sacó del ledger y la pierna de Soroban se cobró."
    : "\nNO SE RECUPERÓ");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error("FALLO:", err); process.exit(1); });
