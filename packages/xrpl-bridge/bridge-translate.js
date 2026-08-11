// bridge-translate — módulo de traducción criptográfica MicoPay Bridge
//
// Traduce los dos "lenguajes" del HTLC entre Soroban y XRPL:
//
//  1. Hash: Soroban valida sha256(preimagen) crudo byte a byte;
//     XRPL exige la misma preimagen envuelta en crypto-condition
//     PREIMAGE-SHA-256 (DER). Aquí se deriva TODO desde una sola
//     preimagen — nunca se generan condiciones independientes.
//
//  2. Tiempo: Soroban expira contra ledger sequence absoluto
//     (~5s/ledger en Stellar); XRPL expira contra timestamp de
//     época Ripple vía CancelAfter. Ambos se derivan de un mismo
//     margen wall-clock respetando la invariante:
//         timeout del iniciador > timeout de la contraparte
//     Quien bloquea primero siempre tiene tiempo de reaccionar
//     después de que el otro revela el secreto.

const crypto = require("crypto");

const RIPPLE_EPOCH_OFFSET = 946684800; // 2000-01-01T00:00:00Z en unix
const STELLAR_SECONDS_PER_LEDGER = 5; // promedio red Stellar
// Espejo de htlc-core (contracts/htlc-core/src/lib.rs): MIN_TIMEOUT_LEDGERS = 60
const MIN_TIMEOUT_LEDGERS = 60;
// El piso de la pierna XRPL, derivado del MISMO margen que el de Soroban.
// XRPL no tiene mínimo propio: acepta un CancelAfter a segundos vista, y ahí
// la ventana se cierra antes de que dé tiempo a revelar. El resultado es la
// pierna larga bloqueada sin nadie que la cobre. Comprobar solo la invariante
// iniciador > contraparte NO basta: 1200 s > 5 s la pasa.
const MIN_COUNTERPARTY_TIMEOUT_SEC = MIN_TIMEOUT_LEDGERS * STELLAR_SECONDS_PER_LEDGER;
// Source tag del reto Make Waves (XRPL Commons). Va en toda tx XRPL que emitamos:
// el leaderboard cuenta direcciones que firmaron >=1 tx con este tag, y el conteo
// arranca en el Mainnet Gate — lo que se manda sin tag no se puede reetiquetar.
const SOURCE_TAG = 2607170001;

// ---------- Hash / condición ----------

/** Genera preimagen aleatoria de 32 bytes (el secreto del swap). */
function generatePreimage() {
  return crypto.randomBytes(32);
}

/** Hash que valida Soroban: sha256 crudo de la preimagen. */
function sorobanSecretHash(preimage) {
  return crypto.createHash("sha256").update(preimage).digest();
}

/**
 * Condition PREIMAGE-SHA-256 en DER para XRPL, derivada de la MISMA preimagen.
 * Estructura para preimagen de 32 bytes:
 *   A0 25            — tipo preimage-sha-256, longitud 0x25
 *     80 20 <hash>   — fingerprint = sha256(preimagen), 32 bytes
 *     81 01 20       — cost = longitud de la preimagen (0x20 = 32)
 * El fingerprint ES el mismo hash que valida Soroban — solo cambia el envoltorio.
 */
function xrplCondition(preimage) {
  if (preimage.length !== 32) throw new Error("Preimagen debe ser 32 bytes");
  return xrplConditionFromHash(sorobanSecretHash(preimage));
}

/**
 * Igual que xrplCondition pero desde el hash directamente — para la
 * contraparte, que solo conoce sha256(secreto), nunca la preimagen.
 */
function xrplConditionFromHash(hash) {
  if (hash.length !== 32) throw new Error("Hash debe ser 32 bytes");
  return Buffer.concat([
    Buffer.from([0xa0, 0x25, 0x80, 0x20]),
    hash,
    Buffer.from([0x81, 0x01, 0x20]),
  ]).toString("hex").toUpperCase();
}

/**
 * Fulfillment DER para EscrowFinish (revela la preimagen):
 *   A0 22 80 20 <preimagen>
 */
function xrplFulfillment(preimage) {
  if (preimage.length !== 32) throw new Error("Preimagen debe ser 32 bytes");
  return Buffer.concat([
    Buffer.from([0xa0, 0x22, 0x80, 0x20]),
    preimage,
  ]).toString("hex").toUpperCase();
}

/** swap_id como lo computa AtomicSwapHTLC: sha256(secret_hash). */
function sorobanSwapId(preimage) {
  return crypto.createHash("sha256").update(sorobanSecretHash(preimage)).digest();
}

// ---------- Tiempo ----------

const toRippleTime = (unixSeconds) => unixSeconds - RIPPLE_EPOCH_OFFSET;
const fromRippleTime = (rippleSeconds) => rippleSeconds + RIPPLE_EPOCH_OFFSET;

/**
 * Planifica los timeouts de ambas piernas desde un margen wall-clock común.
 *
 * - `initiatorTimeoutSec`: segundos hasta que el iniciador puede pedir refund
 *   de SU pierna. La contraparte recibe la mitad — la invariante
 *   iniciador > contraparte queda garantizada por construcción.
 * - `currentLedgerSeq`: ledger sequence actual de Stellar (para la pierna Soroban).
 * - `nowUnix`: opcional, para tests deterministas.
 *
 * Devuelve parámetros listos para cada cadena, para cualquiera de las dos
 * direcciones (iniciador en Soroban o iniciador en XRPL).
 */
function planTimeouts({ initiatorTimeoutSec, currentLedgerSeq, nowUnix = Math.floor(Date.now() / 1000) }) {
  if (initiatorTimeoutSec < 2 * MIN_TIMEOUT_LEDGERS * STELLAR_SECONDS_PER_LEDGER) {
    // la mitad (contraparte) debe cumplir MIN_TIMEOUT_LEDGERS del contrato
    throw new Error(
      `initiatorTimeoutSec mínimo: ${2 * MIN_TIMEOUT_LEDGERS * STELLAR_SECONDS_PER_LEDGER}s ` +
      `(contraparte = mitad y debe cubrir MIN_TIMEOUT_LEDGERS=${MIN_TIMEOUT_LEDGERS} de htlc-core)`
    );
  }
  const counterpartyTimeoutSec = Math.floor(initiatorTimeoutSec / 2);

  const secToLedgers = (sec) => Math.ceil(sec / STELLAR_SECONDS_PER_LEDGER);

  return {
    nowUnix,
    initiator: {
      wallClockSec: initiatorTimeoutSec,
      // pierna Soroban: timeout_ledgers relativo (el contrato suma sequence actual)
      soroban: { timeoutLedgers: secToLedgers(initiatorTimeoutSec), expiresAtLedger: currentLedgerSeq + secToLedgers(initiatorTimeoutSec) },
      // pierna XRPL: CancelAfter absoluto en época Ripple
      xrpl: { cancelAfter: toRippleTime(nowUnix + initiatorTimeoutSec) },
    },
    counterparty: {
      wallClockSec: counterpartyTimeoutSec,
      soroban: { timeoutLedgers: secToLedgers(counterpartyTimeoutSec), expiresAtLedger: currentLedgerSeq + secToLedgers(counterpartyTimeoutSec) },
      xrpl: { cancelAfter: toRippleTime(nowUnix + counterpartyTimeoutSec) },
    },
  };
}

/**
 * Verifica la invariante sobre un plan (o sobre timeouts observados on-chain,
 * convertidos a wall-clock). true = seguro.
 */
function checkInvariant(initiatorWallClockSec, counterpartyWallClockSec) {
  return initiatorWallClockSec > counterpartyWallClockSec;
}

/**
 * Las DOS condiciones que deben cumplirse antes de bloquear nada, no solo la
 * invariante. Lanza con el motivo; no devuelve booleano a propósito, para que
 * quien la llame no pueda ignorar el resultado por descuido.
 */
function assertTimeoutsSafe(initiatorWallClockSec, counterpartyWallClockSec) {
  if (counterpartyWallClockSec < MIN_COUNTERPARTY_TIMEOUT_SEC) {
    throw new Error(
      `Timeout de la contraparte demasiado corto: ${counterpartyWallClockSec}s ` +
      `(mínimo ${MIN_COUNTERPARTY_TIMEOUT_SEC}s). Una ventana así se cierra antes ` +
      `de que dé tiempo a revelar y deja la pierna larga bloqueada.`
    );
  }
  if (!checkInvariant(initiatorWallClockSec, counterpartyWallClockSec)) {
    throw new Error(
      `Invariante roto: la pierna del iniciador (${initiatorWallClockSec}s) no dura ` +
      `más que la de la contraparte (${counterpartyWallClockSec}s)`
    );
  }
}

module.exports = {
  RIPPLE_EPOCH_OFFSET,
  STELLAR_SECONDS_PER_LEDGER,
  MIN_TIMEOUT_LEDGERS,
  MIN_COUNTERPARTY_TIMEOUT_SEC,
  SOURCE_TAG,
  generatePreimage,
  sorobanSecretHash,
  sorobanSwapId,
  xrplCondition,
  xrplConditionFromHash,
  xrplFulfillment,
  toRippleTime,
  fromRippleTime,
  planTimeouts,
  checkInvariant,
  assertTimeoutsSafe,
};
