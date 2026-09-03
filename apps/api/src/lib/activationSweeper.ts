/**
 * "Se regresa solo" solo es cierto si alguien manda el EscrowCancel — XRPL
 * no ejecuta nada por su cuenta. Esto es ese "alguien": revisa cada
 * escrow de activación pendiente y, pasado su CancelAfter, cancela.
 *
 * Cualquier cuenta puede mandar EscrowCancel y el XRP siempre vuelve al
 * dueño original (regla de XRPL, no de este código) — así que el firmante
 * de la cancelación no necesita ser el usuario. Aun así, sin
 * XRPL_SWEEPER_SEED configurado y fondeado en la red correcta, esto no
 * puede mandar nada: se queda avisando en el log, no revienta el server.
 */
import * as bt from "@micopaybridge/xrpl-bridge/bridge-translate";
import { cancelXrplLeg } from "./xrpl-leg.js";

interface PendingCancel {
  owner: string;
  offerSequence: number;
  cancelAfterUnix: number;
  attempts: number;
}

const MAX_ATTEMPTS = 20;
const CHECK_INTERVAL_MS = 20_000;

const pending = new Map<string, PendingCancel>();
let started = false;

function key(owner: string, offerSequence: number): string {
  return `${owner}:${offerSequence}`;
}

/** Se llama en cuanto se sabe que el escrow quedó confirmado on-chain. */
export function trackActivationEscrow(params: {
  owner: string;
  offerSequence: number;
  cancelAfterRipple: number;
}): void {
  const cancelAfterUnix = bt.fromRippleTime(params.cancelAfterRipple);
  pending.set(key(params.owner, params.offerSequence), {
    owner: params.owner,
    offerSequence: params.offerSequence,
    cancelAfterUnix,
    attempts: 0,
  });
}

async function sweepOnce(): Promise<void> {
  const seed = process.env.XRPL_SWEEPER_SEED;
  if (!seed) {
    if (pending.size > 0) {
      console.warn(
        `[activation-sweeper] XRPL_SWEEPER_SEED no configurado — ${pending.size} escrow(s) esperando cancelación manual`,
      );
    }
    return;
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  for (const [k, entry] of pending.entries()) {
    if (nowUnix < entry.cancelAfterUnix) continue;

    try {
      const { hash } = await cancelXrplLeg({
        senderSeed: seed,
        owner: entry.owner,
        offerSequence: entry.offerSequence,
      });
      console.log(`[activation-sweeper] cancelado owner=${entry.owner} seq=${entry.offerSequence} hash=${hash}`);
      pending.delete(k);
    } catch (err) {
      entry.attempts += 1;
      const msg = err instanceof Error ? err.message : String(err);
      // tecNO_TARGET: ya no existe (alguien más lo canceló, o ya se resolvió) — no es un fallo.
      if (msg.includes("tecNO_TARGET")) {
        console.log(`[activation-sweeper] owner=${entry.owner} seq=${entry.offerSequence} ya no existe — nada que hacer`);
        pending.delete(k);
        continue;
      }
      console.warn(`[activation-sweeper] intento ${entry.attempts}/${MAX_ATTEMPTS} falló owner=${entry.owner} seq=${entry.offerSequence}: ${msg}`);
      if (entry.attempts >= MAX_ATTEMPTS) {
        console.error(`[activation-sweeper] owner=${entry.owner} seq=${entry.offerSequence} se rindió tras ${MAX_ATTEMPTS} intentos — necesita revisión manual`);
        pending.delete(k);
      }
    }
  }
}

/** Un solo intervalo para todo el proceso — llamar una vez al arrancar. */
export function startActivationSweeper(): void {
  if (started) return;
  started = true;
  setInterval(() => {
    sweepOnce().catch((err) => console.error("[activation-sweeper] sweep falló", err));
  }, CHECK_INTERVAL_MS);
}
