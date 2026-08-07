// Milestone 1 — MicoPay Bridge
// Prueba la primitiva nativa de XRPL: EscrowCreate con condición PREIMAGE-SHA-256
// y EscrowFinish con el fulfillment (la preimagen). Sin smart contract.
//
// Flujo:
//   1. Fondear dos wallets en testnet (faucet)
//   2. Generar preimagen de 32 bytes (el "secreto" compartido del HTLC)
//   3. Derivar condition/fulfillment en formato crypto-conditions (DER)
//   4. Alice crea escrow condicional hacia Bob con CancelAfter
//   5. Bob lo reclama revelando la preimagen (EscrowFinish)
//
// La misma preimagen es la que en el swap real desbloquea el contrato Soroban:
// Soroban valida sha256(preimagen) crudo; XRPL valida la condición DER derivada
// de esa MISMA preimagen. Ese es el corazón del bridge.

const xrpl = require("xrpl");
const crypto = require("crypto");
const cc = require("five-bells-condition");

// Source tag del reto Make Waves — mismo valor que bridge-translate.SOURCE_TAG
// (este demo es standalone a propósito: no importa el módulo de traducción).
const SOURCE_TAG = 2607170001;

const TESTNET = "wss://s.altnet.rippletest.net:51233";

// XRPL usa época Ripple: segundos desde 2000-01-01T00:00:00Z
const RIPPLE_EPOCH_OFFSET = 946684800;
const toRippleTime = (unixSeconds) => unixSeconds - RIPPLE_EPOCH_OFFSET;

async function main() {
  const client = new xrpl.Client(TESTNET);
  await client.connect();
  console.log("Conectado a testnet");

  // 1. Wallets
  console.log("Fondeando wallets (faucet)...");
  const { wallet: alice } = await client.fundWallet();
  const { wallet: bob } = await client.fundWallet();
  console.log("  Alice:", alice.address);
  console.log("  Bob:  ", bob.address);

  // 2. Preimagen — en el swap real vendría del iniciador y sería la misma en Soroban
  const preimage = crypto.randomBytes(32);
  console.log("Preimagen (secreto):", preimage.toString("hex"));
  console.log("sha256 crudo (lo que validaría Soroban):", crypto.createHash("sha256").update(preimage).digest("hex"));

  // 3. Condition + fulfillment (crypto-conditions DER, lo que valida XRPL)
  const fulfillmentObj = new cc.PreimageSha256();
  fulfillmentObj.setPreimage(preimage);
  const condition = fulfillmentObj.getConditionBinary().toString("hex").toUpperCase();
  const fulfillment = fulfillmentObj.serializeBinary().toString("hex").toUpperCase();
  console.log("Condition (XRPL):", condition);

  // 4. EscrowCreate: Alice -> Bob, 10 XRP, cancelable en 1 hora
  const cancelAfter = toRippleTime(Math.floor(Date.now() / 1000) + 3600);
  const createTx = await client.submitAndWait(
    {
      TransactionType: "EscrowCreate",
      Account: alice.address,
      SourceTag: SOURCE_TAG,
      Destination: bob.address,
      Amount: xrpl.xrpToDrops("10"),
      Condition: condition,
      CancelAfter: cancelAfter,
    },
    { autofill: true, wallet: alice }
  );
  const createResult = createTx.result.meta.TransactionResult;
  console.log("EscrowCreate:", createResult);
  if (createResult !== "tesSUCCESS") throw new Error("EscrowCreate falló");
  const offerSequence = createTx.result.tx_json.Sequence;

  // 5. EscrowFinish: Bob reclama revelando la preimagen (queda pública on-chain)
  const finishTx = await client.submitAndWait(
    {
      TransactionType: "EscrowFinish",
      Account: bob.address,
      SourceTag: SOURCE_TAG,
      Owner: alice.address,
      OfferSequence: offerSequence,
      Condition: condition,
      Fulfillment: fulfillment,
    },
    { autofill: true, wallet: bob }
  );
  const finishResult = finishTx.result.meta.TransactionResult;
  console.log("EscrowFinish:", finishResult);
  if (finishResult !== "tesSUCCESS") throw new Error("EscrowFinish falló");

  const bobBalance = await client.getXrpBalance(bob.address);
  console.log("Balance final de Bob:", bobBalance, "XRP (recibió los 10 del escrow)");
  console.log("\nPrimitiva HTLC nativa de XRPL verificada. Milestone 1 completo.");

  await client.disconnect();
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
