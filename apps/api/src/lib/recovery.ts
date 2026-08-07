/**
 * Recuperación de swaps que se quedaron a medias.
 *
 * El camino del producto ejecuta las cuatro operaciones en un solo proceso.
 * Si ese proceso muere a mitad, antes no lo reanudaba nadie: el swapStore
 * dejaba constancia y ahí se quedaba, con fondos bloqueados en una cadena o en
 * las dos, esperando a que una persona se diera cuenta.
 *
 * La preimagen NO se persiste, y es a propósito. Es lo único que separa un
 * swap atómico de un robo: si la contraparte la obtiene sin haber revelado en
 * su pierna, cobra la del iniciador y no entrega nada. Escribirla en disco
 * para poder "recuperar mejor" sería cambiar atomicidad por comodidad.
 *
 * Eso deja dos escenarios, y la diferencia entre ellos es dónde murió:
 *
 *   - Murió DESPUÉS de revelar. La preimagen ya es pública en el ledger de
 *     XRPL — el EscrowFinish la lleva dentro. Se recupera de ahí y se cobra la
 *     pierna de Soroban. El swap se completa. Nadie pierde nada.
 *   - Murió ANTES de revelar. El secreto se fue con el proceso y no hay forma
 *     de completar. Único final correcto: reembolsar las dos piernas.
 *
 * La verdad se lee de las cadenas, no del estado guardado: el estado puede
 * haberse quedado corto justo por el crash que estamos reparando.
 */

import { Client } from "xrpl";
import { findRevealedPreimage } from "@micopaybridge/xrpl-bridge/relay";
import { swapStore, pendingRefunds, type SwapState } from "./swapStore.js";
import { XRPL_SERVER } from "./xrpl-leg.js";
import { claimSorobanWithSecret, refundSwap, type XrplLegConfig } from "./soroban.js";

/** Estados desde los que un swap todavía puede moverse. */
const NO_TERMINALES: SwapState["status"][] = [
  "queued", "locking_a", "locked_a", "locking_b", "locked_b",
  "releasing_b", "released_b", "releasing_a", "refund_pending",
];

export interface RecoveryConfig {
  initiatorSecret: string;
  counterpartySecret: string;
  contractA: string;
  xrplLeg: XrplLegConfig;
}

export interface RecoveryReport {
  revisados: number;
  completados: string[];
  reembolsados: string[];
  pendientes: string[];
}

const log = (msg: string, extra?: unknown) =>
  console.log(`[recovery] ${msg}${extra !== undefined ? " " + JSON.stringify(extra) : ""}`);

/**
 * Se llama al arrancar la API. No lanza: un fallo recuperando un swap no debe
 * impedir que el servidor levante, pero sí tiene que verse en el log.
 */
export async function recoverInFlightSwaps(config: RecoveryConfig): Promise<RecoveryReport> {
  const aMedias = [...swapStore.values()].filter((s) => NO_TERMINALES.includes(s.status));
  const report: RecoveryReport = { revisados: aMedias.length, completados: [], reembolsados: [], pendientes: [] };

  if (aMedias.length === 0) {
    log("nada a medias");
    return report;
  }
  log(`${aMedias.length} swap(s) a medias`, aMedias.map((s) => `${s.swap_id}:${s.status}`));

  for (const swap of aMedias) {
    try {
      const completado = await intentarCompletar(swap, config);
      if (completado) {
        report.completados.push(swap.swap_id);
        continue;
      }
      // No se pudo completar: si hay algo bloqueado, toca devolverlo.
      if (swap.txs.lock_a || swap.txs.lock_b) {
        swapStore.set(swap.swap_id, {
          ...swapStore.get(swap.swap_id)!,
          status: "refund_pending",
          error: swap.error ?? "proceso interrumpido antes de revelar — la preimagen no sobrevive por diseño",
          updated_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      log(`error revisando ${swap.swap_id}`, String(err));
      report.pendientes.push(swap.swap_id);
    }
  }

  await reintentarReembolsos(config, report);
  log("resumen", report);
  return report;
}

/**
 * Si la preimagen se reveló en XRPL, está pública en el ledger. Se recupera y
 * se cobra la pierna de Soroban — el swap termina bien pese al crash.
 */
async function intentarCompletar(swap: SwapState, config: RecoveryConfig): Promise<boolean> {
  if (!swap.xrpl || !swap.secret_hash) return false;
  if (swap.txs.release_a) return false; // ya estaba cobrada
  if (!swap.txs.lock_a) return false;   // no hay pierna que cobrar

  const client = new Client(XRPL_SERVER);
  await client.connect();
  let preimage: Buffer | null = null;
  try {
    // Filtrado por el hash de ESTE swap: la cuenta puede haber cerrado otros.
    preimage = await findRevealedPreimage(client, swap.xrpl.owner, Buffer.from(swap.secret_hash, "hex"));
  } finally {
    await client.disconnect();
  }

  if (!preimage) {
    log(`${swap.swap_id}: no se reveló en XRPL, no hay secreto que recuperar`);
    return false;
  }

  log(`${swap.swap_id}: preimagen recuperada del ledger, cobrando la pierna de Soroban`);
  const hash = await claimSorobanWithSecret(swap.swap_id, config.counterpartySecret, config.contractA, preimage);
  log(`${swap.swap_id}: completado`, { release_a: hash });
  return true;
}

async function reintentarReembolsos(config: RecoveryConfig, report: RecoveryReport): Promise<void> {
  for (const swap of pendingRefunds()) {
    try {
      const r = await refundSwap(swap.swap_id, config.initiatorSecret, config.contractA, config.xrplLeg);
      if (r.pending.length === 0) report.reembolsados.push(swap.swap_id);
      else {
        // Lo normal al principio: ninguna cadena reembolsa antes de su timeout.
        report.pendientes.push(swap.swap_id);
        log(`${swap.swap_id}: reembolso aún no procede`, r.pending);
      }
    } catch (err) {
      report.pendientes.push(swap.swap_id);
      log(`${swap.swap_id}: error reembolsando`, String(err));
    }
  }
}

/**
 * Reintento periódico. Un swap que murió justo antes de su timeout no se puede
 * reembolsar en el arranque: hay que volver más tarde. Sin esto, "recuperado"
 * solo valdría para los que ya estaban vencidos.
 */
export function startRefundRetryLoop(config: RecoveryConfig, everyMs = 5 * 60_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    const pendientes = pendingRefunds();
    if (pendientes.length === 0) return;
    const report: RecoveryReport = { revisados: pendientes.length, completados: [], reembolsados: [], pendientes: [] };
    reintentarReembolsos(config, report)
      .then(() => log("reintento periódico", report))
      .catch((err) => log("reintento periódico falló", String(err)));
  }, everyMs);
  timer.unref?.();
  return timer;
}
