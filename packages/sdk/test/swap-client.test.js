/**
 * Regresión de AtomicSwapClient.getStatus().
 *
 * El bug: SwapStatus es un #[contracttype] enum sin datos asociados
 * (htlc-core/src/types.rs → Locked/Released/Refunded). Soroban lo codifica
 * como un Vec<Symbol> de un elemento, así que scValToNative() devuelve
 * ["Locked"], no "Locked". El código original hacía raw.toLowerCase() y
 * tronaba con "raw.toLowerCase is not a function" en TODA llamada real —
 * getStatus() no había funcionado nunca.
 *
 * Estos tests no tocan la red: sustituyen el cliente RPC por un doble y
 * construyen ScVal reales, así que ejercitan el mismo scValToNative() que
 * corre en producción. Antes de este archivo el workspace @micopay/sdk no
 * declaraba `test`, y con turbo un script ausente se salta en silencio: el
 * arreglo estaba sin cubrir.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { xdr } from "@stellar/stellar-sdk";
import { AtomicSwapClient } from "../dist/swap-client.js";

// Contrato AtomicSwapHTLC de testnet — solo tiene que ser un strkey válido:
// nada de esto sale a la red.
const CONTRACT_ID = "CCDOUXIXSFXT2HTJAJGFNUJN6CKCYX2M6AL2BHHPEF6ISNHP2BGLS4KX";
const SWAP_ID = "ab".repeat(32);

/** Cliente con el RPC sustituido por un doble que devuelve `retval`. */
function clienteQueDevuelve(retval) {
  const c = new AtomicSwapClient(CONTRACT_ID, "testnet");
  // `server` es privado en TS, pero en runtime es una propiedad normal: es la
  // costura por la que se inyecta el doble.
  c.server = {
    simulateTransaction: async () => (retval === undefined ? {} : { result: { retval } }),
  };
  return c;
}

test("enum sin datos: Soroban lo manda como Vec<Symbol> y se decodifica igual", async () => {
  const retval = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Locked")]);
  const status = await clienteQueDevuelve(retval).getStatus(SWAP_ID);
  assert.equal(status, "locked");
});

test("las tres variantes de SwapStatus se mapean en minúsculas", async () => {
  for (const [variante, esperado] of [
    ["Locked", "locked"],
    ["Released", "released"],
    ["Refunded", "refunded"],
  ]) {
    const retval = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variante)]);
    const status = await clienteQueDevuelve(retval).getStatus(SWAP_ID);
    assert.equal(status, esperado, `variante ${variante}`);
  }
});

test("símbolo suelto (sin envolver en Vec) también se acepta", async () => {
  // Defensivo: si una versión del SDK deja de envolverlo, no debe volver a
  // romperse por asumir una sola de las dos formas.
  const retval = xdr.ScVal.scvSymbol("Released");
  const status = await clienteQueDevuelve(retval).getStatus(SWAP_ID);
  assert.equal(status, "released");
});

test("sin valor de retorno, falla explícito en vez de devolver basura", async () => {
  await assert.rejects(
    () => clienteQueDevuelve(undefined).getStatus(SWAP_ID),
    /No return value from get_status/,
  );
});
