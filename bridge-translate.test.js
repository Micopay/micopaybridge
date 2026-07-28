// Tests del módulo de traducción. Valida la codificación DER manual contra
// five-bells-condition (implementación de referencia de crypto-conditions)
// y las propiedades de tiempo/invariante.

const assert = require("assert");
const cc = require("five-bells-condition");
const bt = require("./bridge-translate");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("ok -", name);
}

test("condition DER idéntica a five-bells-condition (100 preimágenes aleatorias)", () => {
  for (let i = 0; i < 100; i++) {
    const p = bt.generatePreimage();
    const f = new cc.PreimageSha256();
    f.setPreimage(p);
    assert.strictEqual(bt.xrplCondition(p), f.getConditionBinary().toString("hex").toUpperCase());
    assert.strictEqual(bt.xrplFulfillment(p), f.serializeBinary().toString("hex").toUpperCase());
  }
});

test("fingerprint de la condition == sha256 crudo que valida Soroban", () => {
  const p = bt.generatePreimage();
  const cond = bt.xrplCondition(p);
  const sorobanHash = bt.sorobanSecretHash(p).toString("hex").toUpperCase();
  assert.strictEqual(cond.slice(8, 8 + 64), sorobanHash); // tras A0258020
});

test("swap_id = sha256(secret_hash), como AtomicSwapHTLC.compute_swap_id", () => {
  const p = Buffer.alloc(32, 7);
  const expected = require("crypto")
    .createHash("sha256")
    .update(require("crypto").createHash("sha256").update(p).digest())
    .digest();
  assert.deepStrictEqual(bt.sorobanSwapId(p), expected);
});

test("preimagen != 32 bytes rechazada", () => {
  assert.throws(() => bt.xrplCondition(Buffer.alloc(31)));
  assert.throws(() => bt.xrplFulfillment(Buffer.alloc(33)));
});

test("época Ripple: ida y vuelta + valor conocido", () => {
  // 2026-07-20T00:00:00Z = unix 1784505600
  const unix = 1784505600;
  assert.strictEqual(bt.fromRippleTime(bt.toRippleTime(unix)), unix);
  assert.strictEqual(bt.toRippleTime(946684800), 0); // 2000-01-01 = época 0
});

test("planTimeouts: invariante iniciador > contraparte en ambas cadenas", () => {
  const plan = bt.planTimeouts({ initiatorTimeoutSec: 3600, currentLedgerSeq: 1_000_000, nowUnix: 1784505600 });
  assert.ok(bt.checkInvariant(plan.initiator.wallClockSec, plan.counterparty.wallClockSec));
  assert.ok(plan.initiator.xrpl.cancelAfter > plan.counterparty.xrpl.cancelAfter);
  assert.ok(plan.initiator.soroban.expiresAtLedger > plan.counterparty.soroban.expiresAtLedger);
});

test("planTimeouts: contraparte cumple MIN_TIMEOUT_LEDGERS de htlc-core", () => {
  const plan = bt.planTimeouts({ initiatorTimeoutSec: 600, currentLedgerSeq: 0, nowUnix: 0 });
  assert.ok(plan.counterparty.soroban.timeoutLedgers >= bt.MIN_TIMEOUT_LEDGERS);
});

test("planTimeouts: rechaza margen demasiado corto", () => {
  assert.throws(() => bt.planTimeouts({ initiatorTimeoutSec: 599, currentLedgerSeq: 0 }));
});

console.log(`\n${passed} tests OK`);
