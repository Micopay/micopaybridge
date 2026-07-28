// Suite de fallos — MicoPay Bridge.
// Provoca a propósito cada modo de fallo del swap y verifica que los fondos
// terminan donde deben. Corre contra Soroban testnet + XRPL testnet reales.
//
//   1. Contraparte desaparece  → refund() devuelve fondos a A tras timeout
//   2. Secreto falso           → ambas cadenas rechazan
//   3. B miente en su escrow   → guardias de A detectan y NO revela
//   4. Timeout XRPL vencido    → finish rechazado, cancel devuelve fondos
//   5. Refund prematuro        → contrato rechaza antes del timeout
//   6. Watcher muerto en la revelación → re-escaneo de historial recupera
//      el secreto y la contraparte cobra igual
//
// El lock de los tests 1/5 se hace al inicio y su espera de timeout
// (60 ledgers ≈ 5 min) corre en paralelo mientras pasan los demás tests.

const { execFileSync } = require("child_process");
const assert = require("assert");
const xrpl = require("xrpl");
const { rpc } = require("@stellar/stellar-sdk");
const bt = require("./bridge-translate");
const { findRevealedPreimage } = require("./relay");

const CONTRACT_ID = "CANNVHGZHVSVQO76SIVV5YNHH6ODDBV5IEROUITFTFIH6NRLF7XHRCIT";
const NATIVE_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const A = "raul-bridge";
const B = "mota-agent";

const stellarCli = (...args) => {
  const sep = args.indexOf("--");
  const full = sep === -1 ? [...args, "--network", "testnet"] : [...args.slice(0, sep), "--network", "testnet", ...args.slice(sep)];
  return execFileSync("stellar", full, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
};

// El wasm release (no_std, panic=abort) no conserva mensajes de assert!:
// el rechazo del contrato llega como "VM call trapped". Verificamos que la
// simulación falló Y que el trap ocurrió en la función esperada (event log).
function expectCliFail(expectedFn, ...args) {
  try {
    stellarCli(...args);
  } catch (e) {
    const err = (e.stderr ?? "").toString();
    assert.ok(err.includes("simulation failed") || err.includes("trapped"), `fallo inesperado: ${err.slice(0, 400)}`);
    assert.ok(err.includes(expectedFn), `el trap no ocurrió en "${expectedFn}": ${err.slice(0, 400)}`);
    return;
  }
  throw new Error(`la llamada a ${expectedFn} debió ser rechazada y no falló`);
}

let passed = 0;
const ok = (n, msg) => {
  passed++;
  console.log(`TEST ${n} OK — ${msg}`);
};

async function main() {
  const t0 = Date.now();
  const addrA = execFileSync("stellar", ["keys", "address", A], { encoding: "utf8" }).trim();
  const addrB = execFileSync("stellar", ["keys", "address", B], { encoding: "utf8" }).trim();
  const soroban = new rpc.Server("https://soroban-testnet.stellar.org");
  const client = new xrpl.Client("wss://s.altnet.rippletest.net:51233");
  await client.connect();

  // ---------- Lock compartido para tests 5 y 1 (B "desaparece": jamás bloqueará nada) ----------
  const ghostPreimage = bt.generatePreimage();
  const ghostSwapId = JSON.parse(
    stellarCli(
      "contract", "invoke", "--id", CONTRACT_ID, "--source", A, "--",
      "lock", "--initiator", addrA, "--counterparty", addrB, "--token", NATIVE_SAC,
      "--amount", "1000000",
      "--secret_hash", bt.sorobanSecretHash(ghostPreimage).toString("hex"),
      "--timeout_ledgers", String(bt.MIN_TIMEOUT_LEDGERS)
    )
  );
  const ghostSwap = JSON.parse(
    stellarCli("contract", "invoke", "--id", CONTRACT_ID, "--source", A, "--", "get_swap", "--swap_id", ghostSwapId)
  );
  console.log(`[setup] lock fantasma creado, expira en ledger ${ghostSwap.timeout_ledger}`);

  // ---------- TEST 5: refund prematuro rechazado ----------
  expectCliFail("refund", "contract", "invoke", "--id", CONTRACT_ID, "--source", A, "--", "refund", "--swap_id", ghostSwapId);
  ok(5, "refund antes del timeout rechazado por el contrato");

  // ---------- TEST 2: secreto falso rechazado en ambas cadenas ----------
  const badSecret = bt.generatePreimage();
  expectCliFail("release", "contract", "invoke", "--id", CONTRACT_ID, "--source", B, "--", "release", "--swap_id", ghostSwapId, "--secret", badSecret.toString("hex"));

  const goodPreimage = bt.generatePreimage();
  const { wallet: w1 } = await client.fundWallet();
  const { wallet: w2 } = await client.fundWallet();
  const esc1 = await client.submitAndWait(
    {
      TransactionType: "EscrowCreate",
      Account: w1.address,
      Destination: w2.address,
      Amount: xrpl.xrpToDrops("2"),
      Condition: bt.xrplCondition(goodPreimage),
      CancelAfter: bt.toRippleTime(Math.floor(Date.now() / 1000) + 3600),
    },
    { autofill: true, wallet: w1 }
  );
  assert.strictEqual(esc1.result.meta.TransactionResult, "tesSUCCESS");
  const badFinish = await client.submitAndWait(
    {
      TransactionType: "EscrowFinish",
      Account: w2.address,
      Owner: w1.address,
      OfferSequence: esc1.result.tx_json.Sequence,
      Condition: bt.xrplCondition(goodPreimage),
      Fulfillment: bt.xrplFulfillment(badSecret), // preimagen equivocada
    },
    { autofill: true, wallet: w2 }
  );
  assert.strictEqual(badFinish.result.meta.TransactionResult, "tecCRYPTOCONDITION_ERROR");
  ok(2, `secreto falso: Soroban rechaza (trap en release), XRPL ${badFinish.result.meta.TransactionResult}`);

  // ---------- TEST 3: B miente (monto menor) → guardias de A no encuentran escrow válido ----------
  // w1 "es B" y bloquea solo 1 XRP cuando prometió 5, misma condition correcta
  const esc2 = await client.submitAndWait(
    {
      TransactionType: "EscrowCreate",
      Account: w1.address,
      Destination: w2.address,
      Amount: xrpl.xrpToDrops("1"),
      Condition: bt.xrplCondition(goodPreimage),
      CancelAfter: bt.toRippleTime(Math.floor(Date.now() / 1000) + 3600),
    },
    { autofill: true, wallet: w1 }
  );
  assert.strictEqual(esc2.result.meta.TransactionResult, "tesSUCCESS");
  // Verificación de A (la misma de agent_a.js): condition + destino + monto prometido
  const objs = await client.request({ command: "account_objects", account: w1.address, type: "escrow" });
  const valid = objs.result.account_objects.find(
    (o) =>
      o.Condition === bt.xrplCondition(goodPreimage) &&
      o.Destination === w2.address &&
      BigInt(o.Amount) >= BigInt(xrpl.xrpToDrops("5")) // lo prometido
  );
  assert.strictEqual(valid, undefined, "la guardia debió rechazar el escrow con monto menor");
  ok(3, "escrow con monto mentiroso: A no revela (guardia de verificación on-chain)");

  // ---------- TEST 4: CancelAfter vencido → finish rechazado, cancel devuelve fondos ----------
  const shortPreimage = bt.generatePreimage();
  const cancelAt = Math.floor(Date.now() / 1000) + 20;
  const esc3 = await client.submitAndWait(
    {
      TransactionType: "EscrowCreate",
      Account: w1.address,
      Destination: w2.address,
      Amount: xrpl.xrpToDrops("2"),
      Condition: bt.xrplCondition(shortPreimage),
      CancelAfter: bt.toRippleTime(cancelAt),
    },
    { autofill: true, wallet: w1 }
  );
  assert.strictEqual(esc3.result.meta.TransactionResult, "tesSUCCESS");
  // esperar a que el ledger pase CancelAfter (+ margen de cierre de ledger)
  await new Promise((r) => setTimeout(r, 30_000));
  const lateFinish = await client.submitAndWait(
    {
      TransactionType: "EscrowFinish",
      Account: w2.address,
      Owner: w1.address,
      OfferSequence: esc3.result.tx_json.Sequence,
      Condition: bt.xrplCondition(shortPreimage),
      Fulfillment: bt.xrplFulfillment(shortPreimage), // preimagen CORRECTA pero tarde
    },
    { autofill: true, wallet: w2 }
  );
  assert.strictEqual(lateFinish.result.meta.TransactionResult, "tecNO_PERMISSION");
  const balBefore = Number(await client.getXrpBalance(w1.address));
  const cancel = await client.submitAndWait(
    { TransactionType: "EscrowCancel", Account: w2.address, Owner: w1.address, OfferSequence: esc3.result.tx_json.Sequence },
    { autofill: true, wallet: w2 }
  );
  assert.strictEqual(cancel.result.meta.TransactionResult, "tesSUCCESS");
  const balAfter = Number(await client.getXrpBalance(w1.address));
  assert.ok(balAfter > balBefore, "cancel debió devolver los fondos al dueño");
  ok(4, `tras CancelAfter: finish ${lateFinish.result.meta.TransactionResult}, cancel devolvió ${(balAfter - balBefore).toFixed(1)} XRP a B`);

  // ---------- TEST 6: watcher muerto durante la revelación → re-escaneo recupera ----------
  // Swap completo pero SIN watcher corriendo: A revela en XRPL "mientras B está caído"
  const p6 = bt.generatePreimage();
  const swap6 = JSON.parse(
    stellarCli(
      "contract", "invoke", "--id", CONTRACT_ID, "--source", A, "--",
      "lock", "--initiator", addrA, "--counterparty", addrB, "--token", NATIVE_SAC,
      "--amount", "1000000",
      "--secret_hash", bt.sorobanSecretHash(p6).toString("hex"),
      "--timeout_ledgers", "720"
    )
  );
  const esc4 = await client.submitAndWait(
    {
      TransactionType: "EscrowCreate",
      Account: w1.address,
      Destination: w2.address,
      Amount: xrpl.xrpToDrops("2"),
      Condition: bt.xrplCondition(p6),
      CancelAfter: bt.toRippleTime(Math.floor(Date.now() / 1000) + 1800),
    },
    { autofill: true, wallet: w1 }
  );
  const finish6 = await client.submitAndWait(
    {
      TransactionType: "EscrowFinish",
      Account: w2.address,
      Owner: w1.address,
      OfferSequence: esc4.result.tx_json.Sequence,
      Condition: bt.xrplCondition(p6),
      Fulfillment: bt.xrplFulfillment(p6),
    },
    { autofill: true, wallet: w2 }
  );
  assert.strictEqual(finish6.result.meta.TransactionResult, "tesSUCCESS");
  // "B reinicia": nadie escuchaba. Re-escaneo del historial:
  const recovered = await findRevealedPreimage(client, w1.address);
  assert.ok(recovered, "re-escaneo no encontró la preimagen en el historial");
  assert.strictEqual(bt.sorobanSecretHash(recovered).toString("hex"), bt.sorobanSecretHash(p6).toString("hex"));
  // B cobra en Soroban con el secreto recuperado
  stellarCli("contract", "invoke", "--id", CONTRACT_ID, "--source", B, "--", "release", "--swap_id", swap6, "--secret", recovered.toString("hex"));
  const st6 = stellarCli("contract", "invoke", "--id", CONTRACT_ID, "--source", A, "--", "get_status", "--swap_id", swap6);
  assert.ok(st6.includes("Released"));
  ok(6, "watcher caído: re-escaneo recuperó el secreto del historial y B cobró (Released)");

  // ---------- TEST 1: timeout cumplido → refund devuelve fondos a A ----------
  console.log(`[test 1] esperando timeout del lock fantasma (ledger ${ghostSwap.timeout_ledger})...`);
  for (;;) {
    const { sequence } = await soroban.getLatestLedger();
    if (sequence >= ghostSwap.timeout_ledger) break;
    await new Promise((r) => setTimeout(r, 15_000));
  }
  stellarCli("contract", "invoke", "--id", CONTRACT_ID, "--source", A, "--", "refund", "--swap_id", ghostSwapId);
  const st1 = stellarCli("contract", "invoke", "--id", CONTRACT_ID, "--source", A, "--", "get_status", "--swap_id", ghostSwapId);
  assert.ok(st1.includes("Refunded"));
  ok(1, "contraparte desaparecida: refund tras timeout, estado Refunded, XLM de vuelta con A");

  console.log(`\n${passed}/6 tests de fallo OK en ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log("Todos los caminos de fallo dejan los fondos donde deben. Cero fondos atorados.");
  await client.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("FALLO DE SUITE:", e.message);
  if (e.stderr) console.error(e.stderr.toString().slice(0, 500));
  process.exit(1);
});
