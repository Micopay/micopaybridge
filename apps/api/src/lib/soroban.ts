/**
 * Orquestación del atomic swap de dos piernas — Soroban ↔ XRPL.
 *
 *   1. El iniciador bloquea sell_asset en AtomicSwapHTLC (Soroban), timeout LARGO
 *   2. La contraparte bloquea XRP en un escrow de XRPL con la MISMA condición,
 *      timeout CORTO
 *   3. El iniciador revela la preimagen en XRPL y cobra el XRP
 *   4. La contraparte usa esa preimagen —ya pública— para cobrar en Soroban
 *
 * Hasta M4.5 el paso 2 iba contra ATOMIC_SWAP_CONTRACT_B, una segunda
 * instancia del mismo contrato de Soroban. Era una pierna simulada: las dos
 * mitades vivían en la misma cadena, así que el swap no cruzaba nada.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import crypto from "crypto";
import * as bt from "@micopaybridge/xrpl-bridge/bridge-translate";
import { swapStore, type SwapState } from "./swapStore.js";
import { lockXrplLeg, revealOnXrpl, cancelXrplLeg, xrplAddressFromSeed } from "./xrpl-leg.js";

const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NET      = StellarSdk.Networks.TESTNET;

const USDC_ISSUER = process.env.USDC_ISSUER ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC_SAC    = new StellarSdk.Asset("USDC", USDC_ISSUER).contractId(NET);
const XLM_SAC     = StellarSdk.Asset.native().contractId(NET);

function tokenSac(asset: string): string {
  return asset === "XLM" ? XLM_SAC : USDC_SAC;
}

function addressVal(str: string): StellarSdk.xdr.ScVal {
  return StellarSdk.Address.fromString(str).toScVal();
}
function i128Val(n: bigint): StellarSdk.xdr.ScVal {
  return StellarSdk.nativeToScVal(n, { type: "i128" });
}
function u32Val(n: number): StellarSdk.xdr.ScVal {
  return StellarSdk.nativeToScVal(n, { type: "u32" });
}
function bytesVal(hexStr: string): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvBytes(Buffer.from(hexStr, "hex"));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function invokeContract(
  signerKP:   StellarSdk.Keypair,
  contractId: string,
  method:     string,
  args:       StellarSdk.xdr.ScVal[]
): Promise<string> {
  const rpc      = new StellarSdk.rpc.Server(RPC_URL);
  const account  = await rpc.getAccount(signerKP.publicKey());
  const contract = new StellarSdk.Contract(contractId);

  let tx = new StellarSdk.TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: NET,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(180)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation error [${method}]: ${sim.error}`);
  }

  tx = StellarSdk.rpc.assembleTransaction(tx, sim).build();
  tx.sign(signerKP);

  const result = await rpc.sendTransaction(tx);
  if (result.status === "ERROR") {
    throw new Error(`Send error [${method}]: ${JSON.stringify(result.errorResult)}`);
  }

  // Poll for ledger confirmation (~5s per ledger)
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const status = await rpc.getTransaction(result.hash);
    if (status.status === "SUCCESS") return result.hash;
    if (status.status === "FAILED")  throw new Error(`Tx failed [${method}]: ${result.hash}`);
  }
  throw new Error(`Timeout waiting for tx [${method}]: ${result.hash}`);
}

export interface XrplLegConfig {
  /** Semilla de quien bloquea el XRP (la contraparte). */
  counterpartySeed: string;
  /** Semilla de quien revela y cobra el XRP (el iniciador). */
  initiatorSeed: string;
}

/**
 * Corre el swap completo en segundo plano, actualizando swapStore en cada
 * paso para que el endpoint de estado pueda seguirlo.
 *
 * Nota de custodia, para que no se lea de más: la API firma con SUS PROPIAS
 * llaves de demo (PLATFORM_SECRET_KEY, DEMO_AGENT_SECRET_KEY y las dos
 * semillas de XRPL), no con las de ningún usuario. Es un demo donde la
 * plataforma hace de las dos partes. El flujo no custodio de dos agentes
 * independientes es el de packages/xrpl-bridge (agent_a.js / agent_b.js).
 */
export async function executeAtomicSwapBackground(
  swapId:          string,
  initiatorSecret: string,
  counterpartySecret: string,
  contractA:       string,
  xrplLeg:         XrplLegConfig,
  sellAsset:       string,
  sellAmount:      number,
  buyAsset:        string,
  buyAmount:       number,
  initiatorLedgers:    number,
  counterpartyLedgers: number,
): Promise<void> {
  const update = (patch: Partial<SwapState>) => {
    const current = swapStore.get(swapId)!;
    swapStore.set(swapId, { ...current, ...patch, updated_at: new Date().toISOString() });
  };
  const txs = () => swapStore.get(swapId)!.txs;

  const initiatorKP    = StellarSdk.Keypair.fromSecret(initiatorSecret);
  const counterpartyKP = StellarSdk.Keypair.fromSecret(counterpartySecret);

  // Una sola preimagen gobierna las dos piernas. La condition de XRPL se
  // deriva de este mismo hash, nunca de uno independiente: si se generaran
  // por separado no sería un swap atómico, serían dos escrows sin relación.
  const secretBytes = bt.generatePreimage();
  const secret      = secretBytes.toString("hex");
  const secretHash  = bt.sorobanSecretHash(secretBytes);
  const htlcSwapId  = bt.sorobanSwapId(secretBytes).toString("hex");

  const sellToken = tokenSac(sellAsset);
  const sellAmt   = BigInt(Math.round(sellAmount * 10_000_000));

  try {
    if (buyAsset !== "XRP") {
      throw new Error(`La pierna B es XRPL: buy_asset debe ser XRP, llegó ${buyAsset}`);
    }

    // Los timeouts se comprueban en reloj de pared, no en unidades nativas.
    // Cruzar de ledgers de Stellar a época Ripple es donde se pierde en
    // silencio, y se paga en el peor momento: cuando alguien revela tarde.
    //
    // Son DOS condiciones, no una. La invariante sola no basta: con
    // counterparty=1 ledger, 1200s > 5s la pasa, y esos 5 segundos de ventana
    // en XRPL se cierran antes del EscrowFinish — verificado contra testnet,
    // tecNO_PERMISSION y la pierna de Soroban bloqueada.
    const initiatorWallClockSec    = initiatorLedgers * bt.STELLAR_SECONDS_PER_LEDGER;
    const counterpartyWallClockSec = counterpartyLedgers * bt.STELLAR_SECONDS_PER_LEDGER;
    bt.assertTimeoutsSafe(initiatorWallClockSec, counterpartyWallClockSec);

    update({ status: "locking_a", secret_hash: secretHash.toString("hex") });

    // Paso 1 — el iniciador bloquea en Soroban, con el timeout LARGO
    const lockAHash = await invokeContract(initiatorKP, contractA, "lock", [
      addressVal(initiatorKP.publicKey()),
      addressVal(counterpartyKP.publicKey()),
      addressVal(sellToken),
      i128Val(sellAmt),
      bytesVal(secretHash.toString("hex")),
      u32Val(initiatorLedgers),
    ]);
    update({ status: "locked_a", txs: { ...txs(), lock_a: lockAHash } });

    // Paso 2 — la contraparte bloquea XRP con el timeout CORTO. Solo conoce
    // el hash: la preimagen no sale de este proceso hasta el paso 3.
    update({ status: "locking_b" });
    const escrow = await lockXrplLeg({
      counterpartySeed:   xrplLeg.counterpartySeed,
      destinationAddress: xrplAddressFromSeed(xrplLeg.initiatorSeed),
      amountXrp:          String(buyAmount),
      secretHash,
      cancelAfterUnix:    Math.floor(Date.now() / 1000) + counterpartyWallClockSec,
    });
    update({
      status: "locked_b",
      txs: { ...txs(), lock_b: escrow.hash },
      // Se guarda ANTES de revelar: si el proceso muere en el paso 3, esto es
      // lo único con lo que se puede cancelar el escrow y recuperar el XRP.
      xrpl: {
        owner:          escrow.owner,
        offer_sequence: escrow.offerSequence,
        destination:    escrow.destination,
        condition:      escrow.condition,
        cancel_after:   escrow.cancelAfter,
      },
    });

    // Paso 3 — el iniciador revela en XRPL y cobra. La preimagen queda
    // pública en el ledger; nadie tiene que pasársela a nadie.
    update({ status: "releasing_b" });
    const revealed = await revealOnXrpl({
      initiatorSeed: xrplLeg.initiatorSeed,
      owner:         escrow.owner,
      offerSequence: escrow.offerSequence,
      preimage:      secretBytes,
    });
    update({ status: "released_b", txs: { ...txs(), release_b: revealed.hash } });

    // Paso 4 — la contraparte usa esa preimagen ya pública para cobrar en Soroban
    update({ status: "releasing_a" });
    const relAHash = await invokeContract(counterpartyKP, contractA, "release", [
      bytesVal(htlcSwapId),
      bytesVal(secret),
    ]);
    update({ status: "completed", txs: { ...txs(), release_a: relAHash } });

  } catch (err) {
    // Si ya se bloqueó algo, "failed" no basta: hay dinero parado y alguien
    // tiene que devolverlo. Se marca refund_pending para que refundSwap() lo
    // encuentre, y el estado ya persistido lleva owner y offer_sequence.
    const s = swapStore.get(swapId)!;
    const hayFondosBloqueados = !!s.txs.lock_a || !!s.txs.lock_b;
    update({
      status: hayFondosBloqueados ? "refund_pending" : "failed",
      error: String(err),
    });
  }
}

/**
 * Cobra la pierna de Soroban con una preimagen ya revelada.
 *
 * Existe aparte del flujo principal porque la recuperación tras un crash la
 * necesita: si el proceso murió después del EscrowFinish, la preimagen está
 * pública en el ledger de XRPL y el swap todavía se puede cerrar bien.
 */
export async function claimSorobanWithSecret(
  swapId: string,
  counterpartySecret: string,
  contractA: string,
  preimage: Buffer,
): Promise<string> {
  const counterpartyKP = StellarSdk.Keypair.fromSecret(counterpartySecret);
  const htlcSwapId = bt.sorobanSwapId(preimage).toString("hex");

  const current = swapStore.get(swapId);
  if (current) {
    swapStore.set(swapId, { ...current, status: "releasing_a", updated_at: new Date().toISOString() });
  }

  const hash = await invokeContract(counterpartyKP, contractA, "release", [
    bytesVal(htlcSwapId),
    bytesVal(preimage.toString("hex")),
  ]);

  const after = swapStore.get(swapId);
  if (after) {
    swapStore.set(swapId, {
      ...after,
      status: "completed",
      txs: { ...after.txs, release_a: hash },
      updated_at: new Date().toISOString(),
    });
  }
  return hash;
}

/**
 * Devuelve los fondos de un swap que se quedó a medias.
 *
 * No hay prisa ni magia: las dos cadenas solo permiten reembolsar DESPUÉS del
 * timeout, así que esto es idempotente y se puede llamar tantas veces como
 * haga falta hasta que ambas piernas estén resueltas. Lo que no se puede es
 * no llamarlo nunca, que es donde estábamos.
 *
 * Devuelve qué quedó pendiente, para que quien lo llame sepa si repetir.
 */
export async function refundSwap(
  swapId: string,
  initiatorSecret: string,
  contractA: string,
  xrplLeg: XrplLegConfig,
): Promise<{ swap_id: string; refunded: string[]; pending: string[] }> {
  const swap = swapStore.get(swapId);
  if (!swap) throw new Error(`swap desconocido: ${swapId}`);

  const refunded: string[] = [];
  const pending: string[] = [];
  const update = (patch: Partial<SwapState>) => {
    const current = swapStore.get(swapId)!;
    swapStore.set(swapId, { ...current, ...patch, updated_at: new Date().toISOString() });
  };

  // Pierna B (XRPL): EscrowCancel devuelve el XRP a quien lo bloqueó. Solo
  // procede pasado el CancelAfter; antes el ledger lo rechaza.
  if (swap.xrpl && swap.txs.lock_b && !swap.txs.release_b && !swap.txs.refund_b) {
    try {
      const res = await cancelXrplLeg({
        senderSeed: xrplLeg.counterpartySeed,
        owner: swap.xrpl.owner,
        offerSequence: swap.xrpl.offer_sequence,
      });
      update({ txs: { ...swapStore.get(swapId)!.txs, refund_b: res.hash } });
      refunded.push("xrpl");
    } catch (err) {
      pending.push(`xrpl: ${String(err)}`);
    }
  }

  // Pierna A (Soroban): refund() exige que el timeout_ledger haya pasado.
  if (swap.txs.lock_a && !swap.txs.release_a && !swap.txs.refund_a) {
    try {
      const initiatorKP = StellarSdk.Keypair.fromSecret(initiatorSecret);
      const preimageHash = swap.secret_hash;
      if (!preimageHash) throw new Error("el swap no tiene secret_hash guardado");
      const htlcSwapId = crypto.createHash("sha256").update(Buffer.from(preimageHash, "hex")).digest("hex");
      const hash = await invokeContract(initiatorKP, contractA, "refund", [bytesVal(htlcSwapId)]);
      update({ txs: { ...swapStore.get(swapId)!.txs, refund_a: hash } });
      refunded.push("soroban");
    } catch (err) {
      pending.push(`soroban: ${String(err)}`);
    }
  }

  if (pending.length === 0) update({ status: "refunded" });
  return { swap_id: swapId, refunded, pending };
}
