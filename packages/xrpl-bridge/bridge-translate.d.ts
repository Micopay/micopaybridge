/**
 * Tipos de bridge-translate. Escritos a mano: el módulo es CommonJS y se
 * migró tal cual, sin pasarlo a TypeScript (§7 del plan — copiar, poner
 * verde, y después mejorar).
 *
 * Existe para que apps/api consuma la traducción cripto/tiempo en vez de
 * reimplementarla. Es el R-4 del plan: hay una implementación propia
 * validada contra five-bells-condition; no se escribe otra.
 */

/** Segundos entre la época Ripple (2000-01-01) y la Unix. */
export declare const RIPPLE_EPOCH_OFFSET: number;
/** Promedio de cierre de ledger en Stellar. NO es una garantía de la red. */
export declare const STELLAR_SECONDS_PER_LEDGER: number;
/** Espejo de htlc-core: el mínimo que exige `lock` en AtomicSwapHTLC. */
export declare const MIN_TIMEOUT_LEDGERS: number;
/**
 * Piso de la pierna XRPL, derivado del mismo margen que el de Soroban. XRPL no
 * tiene mínimo propio: acepta un CancelAfter a segundos vista.
 */
export declare const MIN_COUNTERPARTY_TIMEOUT_SEC: number;
/** Source tag del reto Make Waves. Va en toda tx XRPL que emitamos. */
export declare const SOURCE_TAG: number;

/** Preimagen aleatoria de 32 bytes: el secreto del swap. */
export declare function generatePreimage(): Buffer;
/** sha256 crudo de la preimagen — lo que valida Soroban byte a byte. */
export declare function sorobanSecretHash(preimage: Buffer): Buffer;
/** swap_id como lo computa AtomicSwapHTLC: sha256(secret_hash). */
export declare function sorobanSwapId(preimage: Buffer): Buffer;

/** Condition PREIMAGE-SHA-256 en DER (hex mayúsculas), desde la preimagen. */
export declare function xrplCondition(preimage: Buffer): string;
/** Igual, pero desde el hash — para quien solo conoce sha256(secreto). */
export declare function xrplConditionFromHash(hash: Buffer): string;
/** Fulfillment DER para EscrowFinish: revela la preimagen. */
export declare function xrplFulfillment(preimage: Buffer): string;

export declare function toRippleTime(unixSeconds: number): number;
export declare function fromRippleTime(rippleSeconds: number): number;

export interface LegTimeouts {
  wallClockSec: number;
  soroban: { timeoutLedgers: number; expiresAtLedger: number };
  xrpl: { cancelAfter: number };
}

export interface TimeoutPlan {
  nowUnix: number;
  initiator: LegTimeouts;
  counterparty: LegTimeouts;
}

/**
 * Deriva los timeouts de ambas piernas de un mismo margen wall-clock.
 * La contraparte recibe la mitad, así que la invariante
 * `iniciador > contraparte` queda garantizada por construcción.
 */
export declare function planTimeouts(params: {
  initiatorTimeoutSec: number;
  currentLedgerSeq: number;
  nowUnix?: number;
}): TimeoutPlan;

/** true = seguro. Comparar SIEMPRE en wall-clock, no en unidades nativas. */
export declare function checkInvariant(
  initiatorWallClockSec: number,
  counterpartyWallClockSec: number
): boolean;

/**
 * Las DOS condiciones antes de bloquear: piso de la contraparte e invariante.
 * Lanza con el motivo — no devuelve booleano, para que no se pueda ignorar.
 */
export declare function assertTimeoutsSafe(
  initiatorWallClockSec: number,
  counterpartyWallClockSec: number
): void;
