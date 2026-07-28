// Agente A (taker/iniciador) — MicoPay Bridge demo autónomo.
//
// Intent: "vender 1 XLM por XRP". El agente ejecuta solo:
//   1. Descubre a B por su catálogo x402 (GET /catalog)
//   2. Negocia (POST /swap/propose) y recibe cotización
//   3. Genera el secreto, bloquea 1 XLM en AtomicSwapHTLC (Soroban)
//      como iniciador — timeout LARGO (invariante)
//   4. Notifica a B; B verifica on-chain y bloquea XRP en XRPL
//   5. VERIFICA el escrow de B on-chain (condition correcta, monto,
//      destino, CancelAfter con margen) — cero confianza en el mensaje
//   6. Reclama el escrow revelando la preimagen (EscrowFinish)
//   7. Espera a que B use el secreto ya público para cobrar en Soroban
//      (confirma vía get_status == Released)

const { execFileSync } = require("child_process");
const xrpl = require("xrpl");
const bt = require("./bridge-translate");

const BASE = "http://localhost:4021";
const CONTRACT_ID = "CANNVHGZHVSVQO76SIVV5YNHH6ODDBV5IEROUITFTFIH6NRLF7XHRCIT";
const IDENTITY = "raul-bridge";
const SELL_XLM = 1;
const INITIATOR_TIMEOUT_SEC = 3600;

const log = (...a) => console.log("[agente-A]", ...a);

const stellarCli = (...args) => {
  const sep = args.indexOf("--");
  const full = sep === -1 ? [...args, "--network", "testnet"] : [...args.slice(0, sep), "--network", "testnet", ...args.slice(sep)];
  return execFileSync("stellar", full, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
};

const api = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`B respondió ${res.status}: ${json.error}`);
  return json;
};

async function main() {
  const sorobanAddress = execFileSync("stellar", ["keys", "address", IDENTITY], { encoding: "utf8" }).trim();

  // 1. Descubrimiento
  const catalog = await api("GET", "/catalog");
  const svc = catalog.services.find((s) => s.name === "swap-xlm-xrp");
  if (!svc) throw new Error("B no ofrece el swap que busco");
  log("servicio descubierto:", svc.description);

  // 2. Negociación
  const wallet = xrpl.Wallet.generate();
  const client = new xrpl.Client("wss://s.altnet.rippletest.net:51233");
  await client.connect();
  const { wallet: myXrplWallet } = await client.fundWallet();

  const proposal = await api("POST", "/swap/propose", {
    sell_asset: "XLM",
    sell_amount: SELL_XLM,
    buy_asset: "XRP",
  });
  log(`cotización aceptada: ${SELL_XLM} XLM -> ${proposal.quote.xrp_amount} XRP (propuesta ${proposal.proposal_id})`);

  // 3. Secreto + lock Soroban (iniciador = timeout largo)
  const preimage = bt.generatePreimage();
  const secretHash = bt.sorobanSecretHash(preimage);
  const timeoutLedgers = Math.ceil(INITIATOR_TIMEOUT_SEC / bt.STELLAR_SECONDS_PER_LEDGER);

  const swapId = JSON.parse(
    stellarCli(
      "contract", "invoke", "--id", CONTRACT_ID, "--source", IDENTITY, "--",
      "lock",
      "--initiator", sorobanAddress,
      "--counterparty", proposal.soroban_address,
      "--token", "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      "--amount", String(SELL_XLM * 10_000_000),
      "--secret_hash", secretHash.toString("hex"),
      "--timeout_ledgers", String(timeoutLedgers)
    )
  );
  log(`bloqueado ${SELL_XLM} XLM en Soroban, swap_id ${swapId}`);

  // 4. Notificar a B
  const { escrow } = await api("POST", "/swap/lock-notify", {
    proposal_id: proposal.proposal_id,
    swap_id: swapId,
    secret_hash: secretHash.toString("hex"),
    xrpl_address: myXrplWallet.address,
  });
  log("B reporta escrow XRPL creado:", escrow.owner, "seq", escrow.offer_sequence);

  // 5. Verificar escrow on-chain — no confiar en el mensaje de B
  const objects = await client.request({ command: "account_objects", account: escrow.owner, type: "escrow" });
  const expectedCondition = bt.xrplCondition(preimage);
  const found = objects.result.account_objects.find(
    (o) =>
      o.Condition === expectedCondition &&
      o.Destination === myXrplWallet.address &&
      BigInt(o.Amount) >= BigInt(xrpl.xrpToDrops(String(proposal.quote.xrp_amount)))
  );
  if (!found) throw new Error("Escrow de B no existe o no coincide (condition/destino/monto)");
  const marginSec = bt.fromRippleTime(found.CancelAfter) - Math.floor(Date.now() / 1000);
  if (marginSec < 300) throw new Error("CancelAfter demasiado cercano, no es seguro revelar");
  log(`escrow verificado on-chain (${xrpl.dropsToXrp(found.Amount)} XRP, margen ${marginSec}s) — revelando`);

  // 6. Reclamar revelando la preimagen
  const finish = await client.submitAndWait(
    {
      TransactionType: "EscrowFinish",
      Account: myXrplWallet.address,
      SourceTag: bt.SOURCE_TAG,
      Owner: escrow.owner,
      OfferSequence: escrow.offer_sequence,
      Condition: expectedCondition,
      Fulfillment: bt.xrplFulfillment(preimage),
    },
    { autofill: true, wallet: myXrplWallet }
  );
  if (finish.result.meta.TransactionResult !== "tesSUCCESS") throw new Error("EscrowFinish falló");
  const balance = await client.getXrpBalance(myXrplWallet.address);
  log(`XRP cobrados (balance ${balance}) — secreto ahora público en XRPL`);

  // 7. Confirmar que B cobró en Soroban con el secreto revelado
  log("esperando a que B reclame en Soroban...");
  const deadline = Date.now() + 90_000;
  let status = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    status = stellarCli("contract", "invoke", "--id", CONTRACT_ID, "--source", IDENTITY, "--", "get_status", "--swap_id", swapId);
    if (status.includes("Released")) break;
  }
  if (!status.includes("Released")) throw new Error("B no reclamó en Soroban a tiempo");

  log("swap Soroban: Released — B cobró con el secreto que revelé");
  console.log("\n=== SWAP AUTÓNOMO COMPLETO ===");
  console.log(`A vendió ${SELL_XLM} XLM, recibió ${proposal.quote.xrp_amount} XRP.`);
  console.log("Descubrimiento, negociación, verificación on-chain y ejecución: sin humanos, sin custodios.");

  await client.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("[agente-A] fatal:", e.message);
  if (e.stderr) console.error(e.stderr.toString());
  process.exit(1);
});
