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

// Vector fijo: la comparación contra five-bells-condition prueba que ambas
// implementaciones coinciden, no que sean CORRECTAS. Si un día cambia la
// librería de referencia, este vector clavado es lo único que lo detecta.
test("vector fijo: preimagen 00..1f → condition, fulfillment y swap_id byte a byte", () => {
  const p = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  assert.strictEqual(
    bt.sorobanSecretHash(p).toString("hex"),
    "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd"
  );
  assert.strictEqual(
    bt.xrplCondition(p),
    "A0258020630DCD2966C4336691125448BBB25B4FF412A49C732DB2C8ABC1B8581BD710DD810120"
  );
  assert.strictEqual(
    bt.xrplFulfillment(p),
    "A0228020000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F"
  );
  assert.strictEqual(
    bt.sorobanSwapId(p).toString("hex"),
    "2f287b4d3d4910f6cada9e1bd1b4648099e8c52c81aa4a6aebfa6fc86f19834e"
  );
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

// El invariante no se cruza sumando números: se cruza entre DOS bases de
// tiempo distintas. STELLAR_SECONDS_PER_LEDGER = 5 es un promedio, no una
// garantía de la red. Si los ledgers cierran más rápido o más lento de lo
// supuesto, la pierna Soroban dura en reloj de pared algo distinto a lo
// planeado — y ahí es donde el invariante se pierde en silencio.
test("relojes adversos: el invariante aguanta de 3 a 9 s/ledger en ambas direcciones", () => {
  const plan = bt.planTimeouts({ initiatorTimeoutSec: 3600, currentLedgerSeq: 1_000_000, nowUnix: 0 });
  const ledgersIniciador = plan.initiator.soroban.timeoutLedgers;
  const ledgersContraparte = plan.counterparty.soroban.timeoutLedgers;

  for (let segPorLedger = 3; segPorLedger <= 9; segPorLedger++) {
    // Dirección 1 — iniciador en Soroban (ledgers), contraparte en XRPL (reloj).
    // Los ledgers RÁPIDOS son los que hacen daño: acortan la pierna larga.
    assert.ok(
      bt.checkInvariant(ledgersIniciador * segPorLedger, plan.counterparty.wallClockSec),
      `iniciador en Soroban pierde el invariante a ${segPorLedger} s/ledger`
    );

    // Dirección 2 — iniciador en XRPL (reloj), contraparte en Soroban (ledgers).
    // Aquí duelen los ledgers LENTOS: alargan la pierna corta.
    assert.ok(
      bt.checkInvariant(plan.initiator.wallClockSec, ledgersContraparte * segPorLedger),
      `contraparte en Soroban pierde el invariante a ${segPorLedger} s/ledger`
    );
  }
});

test("relojes adversos: el margen 2x se rompe fuera de la banda, y se sabe dónde", () => {
  const plan = bt.planTimeouts({ initiatorTimeoutSec: 3600, currentLedgerSeq: 0, nowUnix: 0 });
  // A 10 s/ledger la pierna corta en Soroban alcanza a la larga en XRPL.
  // Documentado a propósito: si algún día se cambia el reparto 1/2 de
  // planTimeouts, este test dice exactamente cuánta holgura se perdió.
  assert.ok(!bt.checkInvariant(plan.initiator.wallClockSec, plan.counterparty.soroban.timeoutLedgers * 10));
  // Y a 2 s/ledger la pierna larga en Soroban se acorta por debajo de la corta.
  assert.ok(!bt.checkInvariant(plan.initiator.soroban.timeoutLedgers * 2, plan.counterparty.wallClockSec));
});

console.log(`\n${passed} tests OK`);
