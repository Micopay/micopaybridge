// Tests del relay: cursor persistido, reanudación e idempotencia.
// Offline — el RPC de Soroban se sustituye por un doble. Lo que se prueba
// aquí es la propiedad del criterio de aceptación: "el relay sobrevive a que
// lo mates a mitad de un swap y lo reinicies".

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { nativeToScVal } = require("@stellar/stellar-sdk");
const bt = require("./bridge-translate");
const { Relay, RelayState, SorobanWatcher, findRevealedPreimage, secretHashFromCondition } = require("./relay");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log("ok -", name);
}

const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-")), "relay-state.json");

/** Evento `released` como lo emite AtomicSwapHTLC: tupla (swap_id, secret). */
function releasedEvent(preimage, ledger) {
  return { ledger, value: nativeToScVal([bt.sorobanSwapId(preimage), preimage]) };
}

/**
 * Doble del rpc.Server. Guarda cada petición para poder afirmar desde dónde
 * reanudó el watcher, y responde lo que le programen.
 */
function fakeServer(respuestas, latest = 1000) {
  return {
    peticiones: [],
    async getLatestLedger() {
      return { sequence: latest };
    },
    async getEvents(req) {
      this.peticiones.push(req);
      const r = respuestas.shift() ?? { events: [], cursor: "vacio", latestLedger: latest };
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

function watcherConDoble({ statePath, respuestas, onReveal, latest = 1000 }) {
  const state = new RelayState(statePath);
  const w = new SorobanWatcher({ contractId: "C_FAKE", state, onReveal });
  w.server = fakeServer(respuestas, latest);
  return w;
}

async function main() {
  await test("arranque limpio: parte del ledger actual, no del génesis", async () => {
    const statePath = tmpState();
    const w = watcherConDoble({ statePath, respuestas: [], onReveal: () => {}, latest: 5000 });
    await w.start();
    await w.stop();
    assert.strictEqual(w.startLedger, 5000);
    assert.strictEqual(w.cursor, null);
  });

  await test("el cursor se persiste tras procesar y el reinicio reanuda desde ahí", async () => {
    const statePath = tmpState();
    const p = bt.generatePreimage();
    const vistos = [];

    const w1 = watcherConDoble({
      statePath,
      respuestas: [{ events: [releasedEvent(p, 1001)], cursor: "CURSOR-1", latestLedger: 1001 }],
      onReveal: ({ preimage }) => vistos.push(preimage.toString("hex")),
    });
    await w1.start();
    await w1.poll();
    await w1.stop();

    assert.deepStrictEqual(vistos, [p.toString("hex")]);
    const guardado = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.strictEqual(guardado.sorobanCursor, "CURSOR-1");

    // "matamos" el relay y lo levantamos otra vez con el mismo archivo
    const w2 = watcherConDoble({ statePath, respuestas: [], onReveal: () => {} });
    await w2.start();
    await w2.poll();
    await w2.stop();
    assert.strictEqual(w2.server.peticiones[0].cursor, "CURSOR-1");
    assert.strictEqual(w2.server.peticiones[0].startLedger, undefined, "reanudó por ledger en vez de por cursor");
  });

  await test("crash a mitad del evento: el cursor NO avanza y el evento se reentrega", async () => {
    const statePath = tmpState();
    const p = bt.generatePreimage();
    const evento = () => ({ events: [releasedEvent(p, 1002)], cursor: "CURSOR-2", latestLedger: 1002 });

    // el manejador revienta a mitad — es el momento exacto del "kill -9"
    const w1 = watcherConDoble({
      statePath,
      respuestas: [evento()],
      onReveal: async () => {
        throw new Error("relay muerto a mitad del EscrowFinish");
      },
    });
    await w1.start();
    await assert.rejects(() => w1.poll(), /muerto a mitad/);
    await w1.stop();

    assert.ok(!fs.existsSync(statePath) || JSON.parse(fs.readFileSync(statePath, "utf8")).sorobanCursor !== "CURSOR-2",
      "el cursor se persistió aunque el evento no quedó atendido");

    // al reiniciar, el mismo evento vuelve a llegar y esta vez sí se atiende
    const vistos = [];
    const w2 = watcherConDoble({
      statePath,
      respuestas: [evento()],
      onReveal: ({ preimage }) => vistos.push(preimage.toString("hex")),
    });
    await w2.start();
    await w2.poll();
    await w2.stop();
    assert.deepStrictEqual(vistos, [p.toString("hex")], "el evento se perdió tras el reinicio");
  });

  await test("cursor más viejo que la retención del RPC: salta al ledger actual y lo avisa", async () => {
    const statePath = tmpState();
    fs.writeFileSync(statePath, JSON.stringify({ sorobanCursor: "CURSOR-ANTIGUO", sorobanLedger: 1 }));

    const w = watcherConDoble({
      statePath,
      respuestas: [new Error("start is before oldest ledger available")],
      onReveal: () => {},
      latest: 9000,
    });
    await w.start();
    await w.tick(); // tick absorbe el error, poll lo lanzaría
    await w.stop();

    assert.strictEqual(w.cursor, null);
    assert.strictEqual(w.startLedger, 9000);
    assert.strictEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).sorobanCursor, null);
  });

  await test("dos polls solapados: el segundo se salta en vez de duplicar", async () => {
    const statePath = tmpState();
    const p = bt.generatePreimage();
    let entregas = 0;
    let soltar;
    const bloqueo = new Promise((r) => (soltar = r));

    const w = watcherConDoble({
      statePath,
      respuestas: [
        { events: [releasedEvent(p, 1003)], cursor: "C-A", latestLedger: 1003 },
        { events: [releasedEvent(p, 1003)], cursor: "C-B", latestLedger: 1003 },
      ],
      onReveal: async () => {
        entregas++;
        await bloqueo; // el primer poll se queda colgado, como un EscrowFinish lento
      },
    });
    await w.start();
    const primero = w.tick();
    await w.tick(); // llega mientras el anterior sigue vivo
    soltar();
    await primero;
    await w.stop();

    assert.strictEqual(entregas, 1, "el poll solapado duplicó la entrega del evento");
  });

  await test("revelación XRPL duplicada: el agente se notifica una sola vez", async () => {
    const p = bt.generatePreimage();
    const notificaciones = [];
    const relay = new Relay({
      statePath: tmpState(),
      onSorobanClaimNeeded: (preimage) => notificaciones.push(preimage.toString("hex")),
    });

    // caso real: el re-escaneo de arranque encuentra la preimagen y, acto
    // seguido, la suscripción entrega la misma tx
    relay.handleXrplReveal(p, {});
    relay.handleXrplReveal(p, { hash: "ABC", ledger_index: 42 });

    assert.deepStrictEqual(notificaciones, [p.toString("hex")]);
  });

  await test("re-escaneo con varios swaps: devuelve el del hash pedido, no el primero", async () => {
    // Una cuenta que ya cerró otros swaps tiene varios EscrowFinish en su
    // historial. Sin filtrar se devolvía el primero, que puede ser de OTRO
    // swap: el agente cobra con el secreto equivocado y la recuperación falla
    // en silencio — justo lo que esta función existe para impedir.
    const pViejo = bt.generatePreimage();
    const pMio = bt.generatePreimage();
    const finish = (p) => ({
      validated: true,
      tx_json: { TransactionType: "EscrowFinish", Owner: "rOWNER", Fulfillment: bt.xrplFulfillment(p) },
      meta: { TransactionResult: "tesSUCCESS" },
    });
    // account_tx devuelve lo más reciente primero: el swap ajeno encabeza
    const client = { request: async () => ({ result: { transactions: [finish(pViejo), finish(pMio)] } }) };

    const hallado = await findRevealedPreimage(client, "rOWNER", bt.sorobanSecretHash(pMio));
    assert.ok(hallado, "no encontró la preimagen pedida");
    assert.strictEqual(hallado.toString("hex"), pMio.toString("hex"), "devolvió la preimagen de otro swap");

    // Y si el swap pedido no está en el historial, null — no la de otro
    const ausente = await findRevealedPreimage(client, "rOWNER", bt.sorobanSecretHash(bt.generatePreimage()));
    assert.strictEqual(ausente, null, "devolvió una preimagen ajena en vez de null");
  });

  await test("secretHashFromCondition: el fingerprint de la condition es el hash de Soroban", () => {
    const p = bt.generatePreimage();
    const hash = secretHashFromCondition(bt.xrplCondition(p));
    assert.deepStrictEqual(hash, bt.sorobanSecretHash(p));
    assert.strictEqual(secretHashFromCondition("A0228020" + "00".repeat(32)), null, "aceptó un fulfillment como condition");
    assert.strictEqual(secretHashFromCondition(undefined), null);
  });

  console.log(`\n${passed} tests OK`);
}

main().catch((e) => {
  console.error("FALLO:", e.message);
  process.exit(1);
});
