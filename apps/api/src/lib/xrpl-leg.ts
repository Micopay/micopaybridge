/**
 * Pierna XRPL del atomic swap — sustituye a ATOMIC_SWAP_CONTRACT_B.
 *
 * Hasta M4.5 la "cadena B" era una segunda instancia del mismo contrato de
 * Soroban: dos piernas en la misma cadena, o sea un swap cross-chain que no
 * cruzaba nada. Aquí la pierna B pasa a ser un escrow nativo de XRPL.
 *
 * No hay contrato que desplegar: XRPL trae el patrón hashlock/timelock en el
 * ledger (`EscrowCreate` con `Condition` PREIMAGE-SHA-256 + `CancelAfter`).
 * Lo único que hace falta es traducir dos lenguajes, y de eso se encarga
 * `@micopaybridge/xrpl-bridge`, que ya está validado byte a byte contra
 * five-bells-condition. Aquí no se re-implementa nada de eso (R-4 del plan).
 *
 * La regla que no se negocia: la `Condition` de XRPL sale de la MISMA
 * preimagen que el `secret_hash` de Soroban. Si se generaran por separado no
 * habría swap atómico, sino dos escrows sin relación.
 */

import { Client, Wallet, xrpToDrops, type EscrowCreate, type EscrowFinish, type EscrowCancel } from "xrpl";
import * as bt from "@micopaybridge/xrpl-bridge/bridge-translate";

export const XRPL_SERVER = process.env.XRPL_SERVER ?? "wss://s.altnet.rippletest.net:51233";

export interface XrplLegResult {
  hash: string;
  /** Sequence del EscrowCreate: junto con el owner identifica el escrow. */
  offerSequence: number;
  owner: string;
  destination: string;
  condition: string;
  cancelAfter: number;
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(XRPL_SERVER);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}

function requireSuccess(result: string, what: string): void {
  if (result !== "tesSUCCESS") throw new Error(`XRPL ${what} falló: ${result}`);
}

/**
 * La contraparte bloquea XRP contra el hash del secreto que ya está en
 * Soroban. Recibe el HASH, no la preimagen: quien bloquea la pierna B nunca
 * conoce el secreto — de eso vive el HTLC.
 */
export async function lockXrplLeg(params: {
  counterpartySeed: string;
  destinationAddress: string;
  amountXrp: string;
  secretHash: Buffer;
  cancelAfterUnix: number;
}): Promise<XrplLegResult> {
  const wallet = Wallet.fromSeed(params.counterpartySeed);
  const condition = bt.xrplConditionFromHash(params.secretHash);
  const cancelAfter = bt.toRippleTime(params.cancelAfterUnix);

  return withClient(async (client) => {
    const tx: EscrowCreate = {
      TransactionType: "EscrowCreate",
      Account: wallet.address,
      // Toda tx que emitimos lleva el source tag del reto Make Waves: el
      // leaderboard solo cuenta lo etiquetado, y no se puede reetiquetar después.
      SourceTag: bt.SOURCE_TAG,
      Destination: params.destinationAddress,
      Amount: xrpToDrops(params.amountXrp),
      Condition: condition,
      CancelAfter: cancelAfter,
    };
    const res = await client.submitAndWait(tx, { autofill: true, wallet });
    requireSuccess((res.result.meta as { TransactionResult: string }).TransactionResult, "EscrowCreate");

    return {
      hash: res.result.hash,
      offerSequence: (res.result.tx_json as { Sequence: number }).Sequence,
      owner: wallet.address,
      destination: params.destinationAddress,
      condition,
      cancelAfter,
    };
  });
}

/**
 * El iniciador revela: el `Fulfillment` lleva la preimagen y queda pública en
 * el ledger para siempre. Ese es el disparo que permite cobrar la pierna de
 * Soroban — no hace falta que nadie se la pase por un canal aparte.
 */
export async function revealOnXrpl(params: {
  initiatorSeed: string;
  owner: string;
  offerSequence: number;
  preimage: Buffer;
}): Promise<{ hash: string }> {
  const wallet = Wallet.fromSeed(params.initiatorSeed);

  return withClient(async (client) => {
    const tx: EscrowFinish = {
      TransactionType: "EscrowFinish",
      Account: wallet.address,
      SourceTag: bt.SOURCE_TAG,
      Owner: params.owner,
      OfferSequence: params.offerSequence,
      Condition: bt.xrplCondition(params.preimage),
      Fulfillment: bt.xrplFulfillment(params.preimage),
    };
    // Ojo: el fee de EscrowFinish escala con el tamaño del fulfillment.
    // autofill lo calcula; no asumir fee base.
    const res = await client.submitAndWait(tx, { autofill: true, wallet });
    requireSuccess((res.result.meta as { TransactionResult: string }).TransactionResult, "EscrowFinish");
    return { hash: res.result.hash };
  });
}

/** Camino de reembolso: pasado el CancelAfter, el XRP vuelve al que bloqueó. */
export async function cancelXrplLeg(params: {
  senderSeed: string;
  owner: string;
  offerSequence: number;
}): Promise<{ hash: string }> {
  const wallet = Wallet.fromSeed(params.senderSeed);

  return withClient(async (client) => {
    const tx: EscrowCancel = {
      TransactionType: "EscrowCancel",
      Account: wallet.address,
      SourceTag: bt.SOURCE_TAG,
      Owner: params.owner,
      OfferSequence: params.offerSequence,
    };
    const res = await client.submitAndWait(tx, { autofill: true, wallet });
    requireSuccess((res.result.meta as { TransactionResult: string }).TransactionResult, "EscrowCancel");
    return { hash: res.result.hash };
  });
}

/** Dirección pública de una semilla, sin exponer la semilla. */
export function xrplAddressFromSeed(seed: string): string {
  return Wallet.fromSeed(seed).address;
}
