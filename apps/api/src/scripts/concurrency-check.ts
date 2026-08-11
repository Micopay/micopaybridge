#!/usr/bin/env node
/**
 * Dos procesos escribiendo el swapStore a la vez.
 *
 *   npm run test:concurrency -w @micopay/api
 *
 * No va en la suite normal porque necesita procesos de verdad: lo que se
 * prueba es precisamente lo que un test en un solo proceso no puede ver.
 *
 * Antes había un único JSON con todos los swaps. Dos procesos lo cargaban,
 * cada uno escribía el suyo, y el segundo en escribir borraba el del primero.
 * Un swap perdido son fondos bloqueados que ya nadie sabe que existen.
 *
 * Este script se ejecuta a sí mismo como hijo (`--hijo`).
 */

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

async function hijo(): Promise<void> {
  const { swapStore } = await import("../lib/swapStore.js");
  const [, , , modo] = process.argv;
  const now = new Date().toISOString();
  const comun = {
    plan_id: "concurrencia",
    sell_asset: "XLM", sell_amount: "1", buy_asset: "XRP", buy_amount: "2",
    chain_b: "xrpl" as const, created_at: now, updated_at: now,
  };

  if (modo === "distinto-a") {
    swapStore.set("SWAP_A", { ...comun, swap_id: "SWAP_A", status: "locked_a", txs: { lock_a: "TX_A" } });
  } else if (modo === "distinto-b") {
    swapStore.set("SWAP_B", { ...comun, swap_id: "SWAP_B", status: "locked_a", txs: { lock_a: "TX_B" } });
  } else if (modo === "mismo-1") {
    // Solo vio el lock de Soroban
    swapStore.set("MISMO", { ...comun, swap_id: "MISMO", status: "locked_a", txs: { lock_a: "TX_LOCK_A" } });
  } else if (modo === "mismo-2") {
    // Ya vio la pierna XRPL entera, pero no el lock de Soroban
    swapStore.set("MISMO", { ...comun, swap_id: "MISMO", status: "released_b", txs: { lock_b: "TX_LOCK_B", release_b: "TX_REVEAL" } });
  }
}

function lanzar(dir: string, modos: string[]): void {
  const hijos = modos.map((m) =>
    // `node --import tsx` es la forma documentada y no depende de dónde npm
    // haya elevado el paquete dentro del monorepo.
    spawnSync(process.execPath, ["--import", "tsx", process.argv[1], "--hijo", m], {
      env: { ...process.env, SWAP_STORE_DIR: dir },
      encoding: "utf8",
    })
  );
  for (const h of hijos) {
    if (h.status !== 0) throw new Error(`hijo falló: ${h.stderr?.slice(0, 400)}`);
  }
}

function main(): void {
  let fallos = 0;

  // ── Caso 1: swaps distintos ─────────────────────────────────────────────
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "swapstore-"));
  lanzar(dir1, ["distinto-a", "distinto-b"]);
  const archivos = fs.readdirSync(dir1).filter((f) => f.endsWith(".json")).sort();
  const ok1 = archivos.length === 2;
  console.log(`[1] swaps distintos, dos procesos → ${archivos.join(", ") || "(nada)"}`);
  console.log(ok1 ? "    OK — los dos sobreviven" : "    ROTO — se perdió uno");
  if (!ok1) fallos++;

  // ── Caso 2: el mismo swap ───────────────────────────────────────────────
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "swapstore-"));
  lanzar(dir2, ["mismo-1", "mismo-2"]);
  const s = JSON.parse(fs.readFileSync(path.join(dir2, "MISMO.json"), "utf8"));
  const ok2 = s.status === "released_b" && s.txs.lock_a && s.txs.lock_b && s.txs.release_b;
  console.log(`[2] el mismo swap, dos procesos → status=${s.status} txs=${Object.keys(s.txs).join(",")}`);
  console.log(ok2 ? "    OK — ninguna escritura perdió la de la otra" : "    ROTO — una pisó a la otra");
  if (!ok2) fallos++;

  fs.rmSync(dir1, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });

  console.log(fallos === 0 ? "\n2/2 OK" : `\n${fallos} caso(s) rotos`);
  process.exit(fallos === 0 ? 0 : 1);
}

if (process.argv.includes("--hijo")) {
  hijo().catch((e) => { console.error(e); process.exit(1); });
} else {
  try { main(); } catch (e) { console.error("FALLO:", e); process.exit(1); }
}
