/**
 * Puente a Xaman (ex-Xumm) para la estrategia de 300 cuentas: crea un
 * "payload" — una tx sin firmar que Xaman muestra como QR / deep link — y
 * el usuario la firma con su propia wallet. El backend nunca ve una seed.
 *
 * Necesita XUMM_API_KEY + XUMM_API_SECRET de https://apps.xaman.dev — hay
 * que crear una cuenta y un proyecto ahí primero (no está en env.example
 * ni se puede inventar, ver docs/ESTRATEGIA_300_CUENTAS.md).
 */
import { XummSdk } from "xumm-sdk";
import { activationTxJson, activationCancelTxJson } from "./xrpl-leg.js";

let sdk: XummSdk | null = null;

function getSdk(): XummSdk {
  const apiKey = process.env.XUMM_API_KEY;
  const apiSecret = process.env.XUMM_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("XUMM_API_KEY/XUMM_API_SECRET no configurados — crea un proyecto en apps.xaman.dev");
  }
  if (!sdk) sdk = new XummSdk(apiKey, apiSecret);
  return sdk;
}

export function xummConfigured(): boolean {
  return Boolean(process.env.XUMM_API_KEY && process.env.XUMM_API_SECRET);
}

export interface ActivationPayload {
  uuid: string;
  qrPng: string;
  deepLink: string;
  websocketUrl: string;
}

/**
 * `cancelAfter` por uuid — lo decidimos nosotros al crear el payload, pero
 * Xaman no nos lo devuelve después. El sweeper lo necesita para saber cuándo
 * ya puede cancelar. En memoria: si el proceso se reinicia a medio camino,
 * el peor caso es un escrow que espera a que alguien lo cancele a mano —
 * el dinero no se pierde, solo se tarda.
 */
const pendingCancelAfter = new Map<string, number>();

export async function createActivationPayload(params: {
  accountAddress: string;
  amountXrp: string;
  cancelAfterSeconds?: number;
}): Promise<ActivationPayload> {
  // Destination === Account (self-escrow) — confirmado leyendo
  // EscrowCreate.cpp de rippled: es un caso de primera clase ("If it's not
  // a self-send..."), no está prohibido. Es la única dirección garantizada
  // de existir en la red donde se firma (tecNO_DST exige que Destination
  // ya esté activada — probado en vivo con una dirección de config que no
  // lo estaba). Este SÍ es el diseño correcto, no una simplificación.
  const txFields = activationTxJson({
    destinationAddress: params.accountAddress,
    amountXrp: params.amountXrp,
    cancelAfterSeconds: params.cancelAfterSeconds,
  });
  const tx = { ...txFields, Account: params.accountAddress };

  // xumm-sdk tipa txjson como Record<string, unknown> & {TransactionType};
  // el EscrowCreate de xrpl.js es una interfaz normal sin index signature —
  // no encajan estructuralmente aunque el shape en runtime es exactamente
  // el que pide. any de frontera, no de descuido.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const created = await getSdk().payload.create({ txjson: tx } as any);
  if (!created) throw new Error("Xaman no devolvió el payload");

  // Number(): Omit<EscrowCreate, "Account"> pierde el tipo literal de
  // CancelAfter en este cruce con xumm-sdk — en runtime siempre es number,
  // lo pusimos dos líneas arriba.
  pendingCancelAfter.set(created.uuid, Number(txFields.CancelAfter));

  return {
    uuid: created.uuid,
    qrPng: created.refs.qr_png,
    deepLink: created.next.always,
    websocketUrl: created.refs.websocket_status,
  };
}

/**
 * Payload de reclamo manual: EscrowCancel para que el propio usuario se
 * devuelva su XRP sin esperar al sweeper. No hace falta saber quién firma
 * de antemano — XRPL manda el reembolso al Owner original sin importar
 * quién mande la cancelación.
 */
export async function createCancelPayload(params: {
  owner: string;
  offerSequence: number;
}): Promise<ActivationPayload> {
  const tx = activationCancelTxJson(params);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const created = await getSdk().payload.create({ txjson: tx } as any);
  if (!created) throw new Error("Xaman no devolvió el payload");

  return {
    uuid: created.uuid,
    qrPng: created.refs.qr_png,
    deepLink: created.next.always,
    websocketUrl: created.refs.websocket_status,
  };
}

export interface ActivationStatus {
  resolved: boolean;
  signed: boolean;
  cancelled: boolean;
  expired: boolean;
  txid: string | null;
  account: string | null;
  /**
   * tesSUCCESS/tec.../null — que Xaman diga signed:true solo significa que
   * aprobaste en la app. Esto es lo que de verdad pasó al someterla a la
   * red (ej. tecNO_PERMISSION si intentas cancelar antes de tiempo).
   */
  dispatchedResult: string | null;
}

export async function getActivationPayloadStatus(uuid: string): Promise<ActivationStatus> {
  const got = await getSdk().payload.get(uuid);
  if (!got) throw new Error("payload no encontrado o expirado");

  return {
    resolved: got.meta.resolved,
    signed: got.meta.signed,
    cancelled: got.meta.cancelled,
    expired: got.meta.expired,
    txid: got.response.txid,
    account: got.response.account,
    dispatchedResult: got.response.dispatched_result ?? null,
  };
}

/** El `CancelAfter` (hora Ripple) que se le puso a este payload al crearlo. */
export function getPendingCancelAfter(uuid: string): number | undefined {
  return pendingCancelAfter.get(uuid);
}

/** Se llama una vez que ya se registró en el sweeper — no hace falta cargarlo en memoria dos veces. */
export function clearPendingCancelAfter(uuid: string): void {
  pendingCancelAfter.delete(uuid);
}
