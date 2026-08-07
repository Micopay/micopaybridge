// El Relevo — relay de dos ledgers de MicoPay Bridge.
//
// Observa ambas cadenas y retransmite el secreto cuando cualquiera de los
// lados lo revela on-chain. NUNCA custodia fondos: solo reenvía una
// preimagen que ya es pública.
//
//  - Soroban revela → AtomicSwapHTLC emite evento `released` con el secreto
//    → el relay envía EscrowFinish en XRPL (cualquier cuenta puede enviarlo;
//    el destino del escrow cobra igual).
//  - XRPL revela → EscrowFinish trae el Fulfillment (preimagen en DER)
//    → el relay extrae la preimagen y la entrega al agente contraparte para
//    que llame release() en Soroban (release exige auth de la contraparte,
//    así que ahí el relay notifica, no firma).

const fs = require("fs");
const xrpl = require("xrpl");
const { Horizon, rpc, xdr, scValToNative } = require("@stellar/stellar-sdk");
const bt = require("./bridge-translate");

const XRPL_TESTNET = "wss://s.altnet.rippletest.net:51233";
const SOROBAN_TESTNET_RPC = "https://soroban-testnet.stellar.org";
const DEFAULT_STATE_PATH = "./relay-state.json";

/**
 * Log de una línea por intento, con swap_id y ledger. Legible y grepeable:
 *   [relay] xrpl_finish_ok swap=a3f1… ledger=6218440 result=tesSUCCESS
 */
function log(event, fields = {}) {
  const kv = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`[relay] ${event}${kv ? " " + kv : ""}`);
}

const shortId = (buf) => (buf ? Buffer.from(buf).toString("hex").slice(0, 12) : undefined);

/**
 * Extrae el hash de una condition DER (A0 25 80 20 <32 bytes> 81 01 20).
 * El fingerprint de la condition ES el secret_hash que valida Soroban.
 * Devuelve Buffer de 32 bytes, o null si no es una condition preimage-sha-256.
 */
function secretHashFromCondition(conditionHex) {
  if (typeof conditionHex !== "string") return null;
  const buf = Buffer.from(conditionHex, "hex");
  if (buf.length !== 39) return null;
  if (buf[0] !== 0xa0 || buf[1] !== 0x25 || buf[2] !== 0x80 || buf[3] !== 0x20) return null;
  return buf.subarray(4, 36);
}

/**
 * Cursor persistido de la pierna Soroban.
 *
 * Sin esto, reiniciar el relay a mitad de un swap arranca desde el ledger
 * actual y los eventos `released` emitidos durante la caída se pierden para
 * siempre: la pierna XRPL nunca se completa y los fondos se quedan hasta el
 * CancelAfter.
 *
 * La pierna XRPL no necesita archivo: su "cursor" es el historial de la
 * cuenta (`account_tx`), que el ledger conserva — por eso se re-escanea con
 * findRevealedPreimage() en cada arranque en vez de persistir posición.
 */
class RelayState {
  constructor(filePath = DEFAULT_STATE_PATH) {
    this.path = filePath;
    this.data = { sorobanCursor: null, sorobanLedger: null };
    if (filePath && fs.existsSync(filePath)) {
      try {
        Object.assign(this.data, JSON.parse(fs.readFileSync(filePath, "utf8")));
      } catch (e) {
        log("state_ilegible", { path: filePath, error: e.message });
      }
    }
  }

  /** Escritura atómica: un crash a mitad no deja el cursor corrupto. */
  save() {
    if (!this.path) return;
    const tmp = `${this.path}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.path);
  }
}

/**
 * Extrae la preimagen de un Fulfillment DER de XRPL (A0 22 80 20 <32 bytes>).
 * Devuelve Buffer o null si no es un fulfillment preimage-sha-256 de 32 bytes.
 */
function extractPreimage(fulfillmentHex) {
  const buf = Buffer.from(fulfillmentHex, "hex");
  if (buf.length !== 36) return null;
  if (buf[0] !== 0xa0 || buf[1] !== 0x22 || buf[2] !== 0x80 || buf[3] !== 0x20) return null;
  return buf.subarray(4);
}

/**
 * Recuperación tras caída: busca en el HISTORIAL de la cuenta dueña del
 * escrow un EscrowFinish exitoso con fulfillment y extrae la preimagen.
 * El secreto queda público on-chain para siempre — si el watcher estaba
 * muerto durante la revelación, esto lo recupera al reiniciar.
 *
 * `expectedSecretHash` (Buffer de 32 bytes) NO es opcional en la práctica:
 * una cuenta que haya cerrado más de un swap tiene varios EscrowFinish en su
 * historial, y sin filtrar se devuelve el primero que aparezca — que puede ser
 * la preimagen de OTRO swap. Con ella, el agente intenta cobrar con el secreto
 * equivocado y la recuperación falla en silencio, que es justo lo que esta
 * función existe para impedir.
 *
 * Se deja opcional solo por compatibilidad con los scripts de un solo swap.
 * Sin ella se registra una advertencia.
 *
 * Devuelve Buffer o null.
 */
async function findRevealedPreimage(client, escrowOwner, expectedSecretHash = null) {
  if (!expectedSecretHash) {
    log("find_preimage_sin_filtro", { owner: escrowOwner, aviso: "devuelve_el_primero_del_historial" });
  }
  const res = await client.request({
    command: "account_tx",
    account: escrowOwner,
    ledger_index_min: -1,
    ledger_index_max: -1,
    limit: 200,
  });
  for (const entry of res.result.transactions) {
    const tx = entry.tx_json ?? entry.tx;
    if (!entry.validated || !tx) continue;
    if (tx.TransactionType !== "EscrowFinish" || tx.Owner !== escrowOwner || !tx.Fulfillment) continue;
    if (entry.meta?.TransactionResult !== "tesSUCCESS") continue;
    const preimage = extractPreimage(tx.Fulfillment);
    if (!preimage) continue;
    if (expectedSecretHash && !bt.sorobanSecretHash(preimage).equals(expectedSecretHash)) continue;
    return preimage;
  }
  return null;
}

/**
 * Observa EscrowFinish en XRPL sobre la cuenta dueña del escrow.
 * Llama onReveal({ preimage, tx }) cuando aparece un fulfillment válido.
 */
class XrplWatcher {
  constructor({ server = XRPL_TESTNET, escrowOwner, onReveal }) {
    this.client = new xrpl.Client(server);
    this.escrowOwner = escrowOwner;
    this.onReveal = onReveal;
  }

  async start() {
    await this.client.connect();
    await this.client.request({ command: "subscribe", accounts: [this.escrowOwner] });
    this.client.on("transaction", (msg) => {
      const tx = msg.tx_json ?? msg.transaction;
      if (!msg.validated || !tx) return;
      if (tx.TransactionType !== "EscrowFinish" || !tx.Fulfillment) return;
      if (msg.meta?.TransactionResult !== "tesSUCCESS") return;
      const preimage = extractPreimage(tx.Fulfillment);
      if (preimage) this.onReveal({ preimage, tx });
    });
  }

  async stop() {
    await this.client.disconnect();
  }
}

/**
 * Observa el evento `released` de AtomicSwapHTLC en Soroban vía polling de
 * getEvents. El evento publica (swap_id, secret) — ver contracts/atomic-swap.
 * Llama onReveal({ preimage, swapId, event }).
 */
class SorobanWatcher {
  constructor({ rpcUrl = SOROBAN_TESTNET_RPC, contractId, onReveal, pollMs = 5000, state = new RelayState() }) {
    this.server = new rpc.Server(rpcUrl);
    this.contractId = contractId;
    this.onReveal = onReveal;
    this.pollMs = pollMs;
    this.state = state;
    this.cursor = state.data.sorobanCursor;
    this.startLedger = state.data.sorobanLedger;
    this.polling = false;
    this.timer = null;
  }

  async start() {
    if (this.cursor || this.startLedger) {
      log("soroban_reanudado", { cursor: this.cursor, ledger: this.startLedger });
    } else {
      const latest = await this.server.getLatestLedger();
      this.startLedger = latest.sequence;
      log("soroban_arranque_limpio", { ledger: this.startLedger });
    }
    this.timer = setInterval(() => this.tick(), this.pollMs);
  }

  /** Un poll a la vez: si el anterior sigue procesando, este ciclo se salta. */
  async tick() {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.poll();
    } catch (e) {
      // El RPC solo conserva ~24 h de eventos. Un cursor más viejo que la
      // retención es irrecuperable: se salta al ledger actual y se avisa
      // FUERTE, porque en esa ventana pudo perderse una revelación.
      if (/cursor|startLedger|ledger/i.test(e.message) && (this.cursor || this.startLedger)) {
        log("soroban_cursor_vencido", { cursor: this.cursor, ledger: this.startLedger, error: e.message });
        const latest = await this.server.getLatestLedger();
        this.cursor = null;
        this.startLedger = latest.sequence;
        this.persist();
      } else {
        log("soroban_poll_error", { error: e.message });
      }
    } finally {
      this.polling = false;
    }
  }

  async poll() {
    const req = {
      filters: [
        {
          type: "contract",
          contractIds: [this.contractId],
          topics: [[xdr.ScVal.scvSymbol("released").toXDR("base64")]],
        },
      ],
    };
    if (this.cursor) req.cursor = this.cursor;
    else req.startLedger = this.startLedger;

    const res = await this.server.getEvents(req);
    for (const ev of res.events ?? []) {
      // value del evento = tupla (swap_id, secret)
      const value = scValToNative(ev.value);
      const [swapId, secret] = Array.isArray(value) ? value : [null, value];
      // await: el cursor NO avanza hasta que el evento quedó atendido. Si el
      // proceso muere aquí, al reiniciar se vuelve a leer este mismo evento.
      await this.onReveal({ preimage: Buffer.from(secret), swapId: swapId && Buffer.from(swapId), event: ev });
    }
    this.cursor = res.cursor;
    if (res.latestLedger) this.startLedger = res.latestLedger;
    this.persist();
  }

  persist() {
    this.state.data.sorobanCursor = this.cursor;
    this.state.data.sorobanLedger = this.startLedger;
    this.state.save();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

/**
 * El relay completo: junta ambos watchers.
 *
 * config = {
 *   xrpl: { escrowOwner, offerSequence, condition, relayWallet }  — pierna XRPL a completar
 *   soroban: { contractId }                                        — pierna Soroban a observar
 *   onSorobanClaimNeeded(preimage)                                 — callback al agente (release necesita su auth)
 * }
 */
class Relay {
  constructor(config) {
    this.config = config;
    this.state = config.state ?? new RelayState(config.statePath);
    this.inFlight = new Set();
  }

  async start() {
    const { config } = this;

    if (config.soroban?.contractId) {
      this.sorobanWatcher = new SorobanWatcher({
        contractId: config.soroban.contractId,
        state: this.state,
        onReveal: async ({ preimage, swapId, event }) => {
          log("soroban_revelado", { swap: shortId(swapId ?? bt.sorobanSwapId(preimage)), ledger: event?.ledger });
          await this.completeXrplLeg(preimage);
        },
      });
      await this.sorobanWatcher.start();
      log("observando_soroban", { contract: config.soroban.contractId });
    }

    if (config.xrpl?.escrowOwner) {
      this.xrplWatcher = new XrplWatcher({
        escrowOwner: config.xrpl.escrowOwner,
        onReveal: ({ preimage, tx }) => this.handleXrplReveal(preimage, tx),
      });
      await this.xrplWatcher.start();
      log("observando_xrpl", { cuenta: config.xrpl.escrowOwner });

      // Recuperación tras caída: lo que se reveló mientras el relay estaba
      // muerto no llega por suscripción, solo está en el historial. Se filtra
      // por el hash de ESTE swap — la cuenta puede haber cerrado otros.
      const recovered = await findRevealedPreimage(
        this.xrplWatcher.client,
        config.xrpl.escrowOwner,
        secretHashFromCondition(config.xrpl.condition)
      );
      if (recovered) {
        log("xrpl_recuperado_de_historial", { swap: shortId(bt.sorobanSwapId(recovered)) });
        this.handleXrplReveal(recovered, {});
      }
    }
  }

  /**
   * XRPL reveló: el relay no puede firmar el release() de Soroban (exige auth
   * de la contraparte), así que solo entrega la preimagen al agente.
   * Idempotente por swap dentro del proceso — el re-escaneo de arranque puede
   * traer la misma preimagen que después llega por suscripción.
   */
  handleXrplReveal(preimage, tx = {}) {
    const swap = bt.sorobanSwapId(preimage).toString("hex");
    if (this.inFlight.has(swap)) {
      log("xrpl_revelado_duplicado_ignorado", { swap: swap.slice(0, 12) });
      return;
    }
    this.inFlight.add(swap);
    log("xrpl_revelado", {
      swap: swap.slice(0, 12),
      ledger: tx.ledger_index,
      tx: tx.hash,
      sha256: bt.sorobanSecretHash(preimage).toString("hex").slice(0, 12),
    });
    this.config.onSorobanClaimNeeded?.(preimage);
  }

  /**
   * Envía EscrowFinish en XRPL con la preimagen revelada en Soroban.
   *
   * Idempotente. La autoridad es la cadena, no el estado local: el objeto
   * escrow desaparece del ledger al completarse o cancelarse, así que su
   * ausencia significa "ya no hay nada que hacer". Reenviar dos veces no
   * paga dos veces — devuelve null y no gasta fee.
   */
  async completeXrplLeg(preimage) {
    const { escrowOwner, offerSequence, relayWallet } = this.config.xrpl;
    const swap = bt.sorobanSwapId(preimage).toString("hex");
    const condition = bt.xrplCondition(preimage);

    if (this.inFlight.has(swap)) {
      log("xrpl_finish_en_curso_ignorado", { swap: swap.slice(0, 12) });
      return null;
    }
    this.inFlight.add(swap);

    const client = new xrpl.Client(this.config.xrpl.server ?? XRPL_TESTNET);
    await client.connect();
    let resuelto = false;
    try {
      // La condition identifica el escrow: se deriva de la preimagen de ESTE
      // swap y ninguna otra la produce. Si no está, ya se completó o se canceló.
      const objs = await client.request({ command: "account_objects", account: escrowOwner, type: "escrow" });
      const escrow = objs.result.account_objects.find((o) => o.Condition === condition);
      if (!escrow) {
        log("xrpl_finish_omitido_escrow_ausente", { swap: swap.slice(0, 12), owner: escrowOwner });
        resuelto = true;
        return null;
      }

      const res = await client.submitAndWait(
        {
          TransactionType: "EscrowFinish",
          Account: relayWallet.address,
          SourceTag: bt.SOURCE_TAG,
          Owner: escrowOwner,
          OfferSequence: offerSequence,
          Condition: condition,
          Fulfillment: bt.xrplFulfillment(preimage),
        },
        { autofill: true, wallet: relayWallet }
      );
      const result = res.result.meta.TransactionResult;
      // tecNO_TARGET = el escrow ya no existe: alguien más lo completó entre
      // la comprobación y el submit. Es el resultado esperado de una carrera,
      // no un fallo del relay.
      resuelto = result === "tesSUCCESS" || result === "tecNO_TARGET";
      log(resuelto ? "xrpl_finish_ok" : "xrpl_finish_fallo", {
        swap: swap.slice(0, 12),
        ledger: res.result.ledger_index,
        tx: res.result.hash,
        result,
      });
      return res;
    } finally {
      // Candado liberado si la pierna no quedó cerrada, para no bloquear un
      // reintento posterior. Ojo con los dos caminos de fallo:
      //  - excepción (red, RPC caído): propaga → tick() no persiste el cursor
      //    → el siguiente poll vuelve a leer el evento y reintenta solo.
      //  - resultado tec* : el ledger ya cobró el fee. NO se reintenta en bucle
      //    a propósito; queda en el log como xrpl_finish_fallo.
      if (!resuelto) this.inFlight.delete(swap);
      await client.disconnect();
    }
  }

  async stop() {
    await this.xrplWatcher?.stop();
    await this.sorobanWatcher?.stop();
  }
}

module.exports = {
  Relay,
  RelayState,
  XrplWatcher,
  SorobanWatcher,
  extractPreimage,
  findRevealedPreimage,
  secretHashFromCondition,
};
