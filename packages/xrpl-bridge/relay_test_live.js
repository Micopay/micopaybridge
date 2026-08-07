// Test en vivo del relay (pierna XRPL, testnet real):
//   1. Alice crea escrow condicional hacia Bob
//   2. Relay observa la cuenta de Alice
//   3. Bob reclama con la preimagen (EscrowFinish)
//   4. Relay debe detectar la revelación, extraer la preimagen y
//      coincidir con el sha256 que validaría Soroban
// También verifica conectividad al RPC de Soroban testnet.

const xrpl = require("xrpl");
const { rpc } = require("@stellar/stellar-sdk");
const bt = require("./bridge-translate");
const { XrplWatcher, extractPreimage } = require("./relay");
const assert = require("assert");

async function main() {
  // Soroban RPC vivo
  const soroban = new rpc.Server("https://soroban-testnet.stellar.org");
  const latest = await soroban.getLatestLedger();
  console.log("Soroban testnet RPC OK, ledger:", latest.sequence);

  // unit: extractPreimage
  const p0 = bt.generatePreimage();
  assert.deepStrictEqual(extractPreimage(bt.xrplFulfillment(p0)), p0);
  assert.strictEqual(extractPreimage("A0"), null);
  console.log("extractPreimage OK");

  const client = new xrpl.Client("wss://s.altnet.rippletest.net:51233");
  await client.connect();
  const { wallet: alice } = await client.fundWallet();
  const { wallet: bob } = await client.fundWallet();
  console.log("Wallets:", alice.address, "/", bob.address);

  const preimage = bt.generatePreimage();
  const expectedHash = bt.sorobanSecretHash(preimage).toString("hex");

  // Relay a la escucha ANTES de la revelación
  const detected = new Promise((resolve) => {
    const watcher = new XrplWatcher({
      escrowOwner: alice.address,
      onReveal: async ({ preimage: got }) => {
        await watcher.stop();
        resolve(got);
      },
    });
    watcher.start().then(() => console.log("Relay observando a", alice.address));
  });

  // Escrow + reclamo
  const create = await client.submitAndWait(
    {
      TransactionType: "EscrowCreate",
      Account: alice.address,
      Destination: bob.address,
      Amount: xrpl.xrpToDrops("5"),
      Condition: bt.xrplCondition(preimage),
      CancelAfter: bt.toRippleTime(Math.floor(Date.now() / 1000) + 3600),
    },
    { autofill: true, wallet: alice }
  );
  assert.strictEqual(create.result.meta.TransactionResult, "tesSUCCESS");
  console.log("EscrowCreate OK");

  const finish = await client.submitAndWait(
    {
      TransactionType: "EscrowFinish",
      Account: bob.address,
      Owner: alice.address,
      OfferSequence: create.result.tx_json.Sequence,
      Condition: bt.xrplCondition(preimage),
      Fulfillment: bt.xrplFulfillment(preimage),
    },
    { autofill: true, wallet: bob }
  );
  assert.strictEqual(finish.result.meta.TransactionResult, "tesSUCCESS");
  console.log("EscrowFinish OK (Bob reveló la preimagen)");

  const got = await Promise.race([
    detected,
    new Promise((_, rej) => setTimeout(() => rej(new Error("relay no detectó la revelación en 30s")), 30000)),
  ]);

  assert.deepStrictEqual(got, preimage, "preimagen extraída != original");
  assert.strictEqual(bt.sorobanSecretHash(got).toString("hex"), expectedHash);
  console.log("\nRelay detectó y extrajo la preimagen. Hash coincide con lo que valida Soroban.");
  console.log("Pierna XRPL del relay verificada en testnet real.");

  await client.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
