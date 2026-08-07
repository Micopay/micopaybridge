// DEMO COMPLETO — MicoPay Bridge: swap atómico XRPL ↔ Soroban en testnets reales.
//
// Escenario (dos agentes, A y B):
//   - Agente A (iniciador) bloquea 1 XLM en AtomicSwapHTLC (Soroban) hacia B,
//     bajo sha256(secreto).
//   - Agente B bloquea 5 XRP en escrow nativo XRPL hacia A, bajo la MISMA
//     condición derivada del MISMO secreto.
//   - B revela el secreto en Soroban al reclamar (release) → evento `released`.
//   - EL RELAY detecta el evento, extrae el secreto y completa la pierna XRPL
//     (EscrowFinish) — A cobra sus XRP sin que nadie custodie nada.
//
// Firma Soroban vía stellar CLI (identidades locales raul-bridge / mota-agent).

const { execFileSync } = require("child_process");
const xrpl = require("xrpl");
const bt = require("./bridge-translate");
const { Relay } = require("./relay");

const CONTRACT_ID = "CANNVHGZHVSVQO76SIVV5YNHH6ODDBV5IEROUITFTFIH6NRLF7XHRCIT";
const NATIVE_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const INITIATOR = "raul-bridge"; // agente A
const COUNTERPARTY = "mota-agent"; // agente B

const stellar = (...args) => {
  // --network solo aplica a subcomandos de contrato; keys address no lo acepta
  const needsNetwork = args[0] === "contract";
  if (needsNetwork) {
    const sep = args.indexOf("--");
    if (sep === -1) args = [...args, "--network", "testnet"];
    else args = [...args.slice(0, sep), "--network", "testnet", ...args.slice(sep)];
  }
  return execFileSync("stellar", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
};

async function main() {
  const initiatorAddr = stellar("keys", "address", INITIATOR);
  const counterpartyAddr = stellar("keys", "address", COUNTERPARTY);
  console.log("Agente A (Soroban):", initiatorAddr);
  console.log("Agente B (Soroban):", counterpartyAddr);

  // El secreto compartido — único origen de verdad de ambas piernas
  const preimage = bt.generatePreimage();
  const secretHash = bt.sorobanSecretHash(preimage);
  console.log("\nSecreto:", preimage.toString("hex"));
  console.log("sha256 (Soroban) / fingerprint (XRPL):", secretHash.toString("hex"));

  // ---- Pierna XRPL: B bloquea 5 XRP hacia A ----
  const client = new xrpl.Client("wss://s.altnet.rippletest.net:51233");
  await client.connect();
  const { wallet: agentB_xrpl } = await client.fundWallet();
  const { wallet: agentA_xrpl } = await client.fundWallet();
  const { wallet: relayWallet } = await client.fundWallet();

  const plan = bt.planTimeouts({ initiatorTimeoutSec: 3600, currentLedgerSeq: 0 });
  const createTx = await client.submitAndWait(
    {
      TransactionType: "EscrowCreate",
      Account: agentB_xrpl.address,
      SourceTag: bt.SOURCE_TAG,
      Destination: agentA_xrpl.address,
      Amount: xrpl.xrpToDrops("5"),
      Condition: bt.xrplCondition(preimage),
      CancelAfter: plan.counterparty.xrpl.cancelAfter,
    },
    { autofill: true, wallet: agentB_xrpl }
  );
  if (createTx.result.meta.TransactionResult !== "tesSUCCESS") throw new Error("EscrowCreate XRPL falló");
  console.log("\n[XRPL] B bloqueó 5 XRP hacia A (escrow condicional)");

  // ---- Relay observando Soroban, listo para completar XRPL ----
  const relay = new Relay({
    soroban: { contractId: CONTRACT_ID },
    xrpl: {
      escrowOwner: agentB_xrpl.address,
      offerSequence: createTx.result.tx_json.Sequence,
      relayWallet,
    },
  });
  await relay.start();

  const balanceBefore = await client.getXrpBalance(agentA_xrpl.address);

  // ---- Pierna Soroban: A bloquea 1 XLM hacia B ----
  const lockOut = stellar(
    "contract", "invoke", "--id", CONTRACT_ID, "--source", INITIATOR, "--",
    "lock",
    "--initiator", initiatorAddr,
    "--counterparty", counterpartyAddr,
    "--token", NATIVE_SAC,
    "--amount", "10000000", // 1 XLM en stroops
    "--secret_hash", secretHash.toString("hex"),
    "--timeout_ledgers", String(plan.initiator.soroban.timeoutLedgers)
  );
  console.log("[Soroban] A bloqueó 1 XLM hacia B. swap_id:", lockOut);

  // ---- B revela el secreto al reclamar en Soroban ----
  const swapId = JSON.parse(lockOut); // el invoke devuelve el BytesN<32> como string hex JSON
  stellar(
    "contract", "invoke", "--id", CONTRACT_ID, "--source", COUNTERPARTY, "--",
    "release",
    "--swap_id", swapId,
    "--secret", preimage.toString("hex")
  );
  console.log("[Soroban] B reclamó revelando el secreto — evento `released` emitido");
  console.log("\nEsperando al relay...");

  // ---- Esperar a que el relay complete la pierna XRPL ----
  const deadline = Date.now() + 90_000;
  let balanceAfter = balanceBefore;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    balanceAfter = await client.getXrpBalance(agentA_xrpl.address);
    if (Number(balanceAfter) > Number(balanceBefore)) break;
  }

  if (Number(balanceAfter) <= Number(balanceBefore)) throw new Error("relay no completó la pierna XRPL a tiempo");

  console.log(`\n[XRPL] A cobró: ${balanceBefore} → ${balanceAfter} XRP`);
  console.log("\n=== SWAP ATÓMICO COMPLETO ===");
  console.log("A entregó 1 XLM en Soroban, recibió 5 XRP en XRPL.");
  console.log("B entregó 5 XRP en XRPL, recibió 1 XLM en Soroban.");
  console.log("Relay solo retransmitió un secreto ya público. Cero custodia.");

  await relay.stop();
  await client.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("Error:", e.message);
  if (e.stderr) console.error(e.stderr.toString());
  process.exit(1);
});
