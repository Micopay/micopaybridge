// Gap 1 — ¿XRPL testnet soporta escrow de TOKENS (XLS-85), no solo XRP?
//
// El pitch necesita RLUSD/IOUs. XLS-85 exige:
//   - amendment TokenEscrow activo en la red
//   - el EMISOR del token con flag AllowTrustLineLocking
//   - destino con trustline al token
//
// Prueba empírica completa con un IOU propio (TST):
//   emisor activa flag → trustlines → emite → EscrowCreate condicional
//   con Amount de token → EscrowFinish con preimagen.

const xrpl = require("xrpl");
const bt = require("./bridge-translate");
const assert = require("assert");

const CURRENCY = "TST";

async function main() {
  const client = new xrpl.Client("wss://s.altnet.rippletest.net:51233");
  await client.connect();

  const { wallet: issuer } = await client.fundWallet();
  const { wallet: alice } = await client.fundWallet();
  const { wallet: bob } = await client.fundWallet();
  console.log("emisor:", issuer.address);

  const submit = async (tx, wallet) => {
    const r = await client.submitAndWait(tx, { autofill: true, wallet });
    return r.result.meta.TransactionResult === "tesSUCCESS" ? r : Promise.reject(new Error(`${tx.TransactionType}: ${r.result.meta.TransactionResult}`));
  };

  // 1. Flag XLS-85 en el emisor (asf 17 = AllowTrustLineLocking)
  try {
    await submit({ TransactionType: "AccountSet", Account: issuer.address, SetFlag: 17 }, issuer);
    console.log("AllowTrustLineLocking activado en el emisor");
  } catch (e) {
    console.log("FALLO al activar flag XLS-85:", e.message);
    console.log("=> TokenEscrow probablemente NO disponible en esta red");
    process.exit(1);
  }

  // 2. Trustlines y emisión
  const limit = { currency: CURRENCY, issuer: issuer.address, value: "1000" };
  await submit({ TransactionType: "TrustSet", Account: alice.address, LimitAmount: limit }, alice);
  await submit({ TransactionType: "TrustSet", Account: bob.address, LimitAmount: limit }, bob);
  await submit(
    { TransactionType: "Payment", Account: issuer.address, Destination: alice.address, Amount: { currency: CURRENCY, issuer: issuer.address, value: "100" } },
    issuer
  );
  console.log("trustlines + 100 TST emitidos a alice");

  // 3. Escrow condicional de TOKENS — la prueba de fuego
  const preimage = bt.generatePreimage();
  const create = await submit(
    {
      TransactionType: "EscrowCreate",
      Account: alice.address,
      Destination: bob.address,
      Amount: { currency: CURRENCY, issuer: issuer.address, value: "10" },
      Condition: bt.xrplCondition(preimage),
      CancelAfter: bt.toRippleTime(Math.floor(Date.now() / 1000) + 3600),
    },
    alice
  );
  console.log("EscrowCreate con TOKEN: tesSUCCESS");

  // 4. Reclamo con preimagen
  await submit(
    {
      TransactionType: "EscrowFinish",
      Account: bob.address,
      Owner: alice.address,
      OfferSequence: create.result.tx_json.Sequence,
      Condition: bt.xrplCondition(preimage),
      Fulfillment: bt.xrplFulfillment(preimage),
    },
    bob
  );

  const lines = await client.request({ command: "account_lines", account: bob.address });
  const bal = lines.result.lines.find((l) => l.currency === CURRENCY)?.balance;
  assert.strictEqual(bal, "10");
  console.log("EscrowFinish OK — bob tiene", bal, "TST");
  console.log("\n=> XLS-85 TokenEscrow FUNCIONA en testnet: el bridge puede mover RLUSD/IOUs, no solo XRP.");

  await client.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
