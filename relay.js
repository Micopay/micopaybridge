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

const xrpl = require("xrpl");
const { Horizon, rpc, xdr, scValToNative } = require("@stellar/stellar-sdk");
const bt = require("./bridge-translate");

const XRPL_TESTNET = "wss://s.altnet.rippletest.net:51233";
const SOROBAN_TESTNET_RPC = "https://soroban-testnet.stellar.org";

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
 * Devuelve Buffer o null.
 */
async function findRevealedPreimage(client, escrowOwner) {
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
    if (preimage) return preimage;
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
  constructor({ rpcUrl = SOROBAN_TESTNET_RPC, contractId, onReveal, pollMs = 5000 }) {
    this.server = new rpc.Server(rpcUrl);
    this.contractId = contractId;
    this.onReveal = onReveal;
    this.pollMs = pollMs;
    this.cursor = null;
    this.timer = null;
  }

  async start() {
    const latest = await this.server.getLatestLedger();
    this.startLedger = latest.sequence;
    this.timer = setInterval(() => this.poll().catch((e) => console.error("[soroban] poll error:", e.message)), this.pollMs);
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
    this.cursor = res.cursor;
    for (const ev of res.events ?? []) {
      // value del evento = tupla (swap_id, secret)
      const value = scValToNative(ev.value);
      const [swapId, secret] = Array.isArray(value) ? value : [null, value];
      this.onReveal({ preimage: Buffer.from(secret), swapId: swapId && Buffer.from(swapId), event: ev });
    }
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
    this.log = (...a) => console.log("[relay]", ...a);
  }

  async start() {
    const { config } = this;

    if (config.soroban?.contractId) {
      this.sorobanWatcher = new SorobanWatcher({
        contractId: config.soroban.contractId,
        onReveal: async ({ preimage, swapId }) => {
          this.log("secreto revelado en Soroban, swap:", swapId?.toString("hex"));
          await this.completeXrplLeg(preimage);
        },
      });
      await this.sorobanWatcher.start();
      this.log("observando Soroban:", config.soroban.contractId);
    }

    if (config.xrpl?.escrowOwner) {
      this.xrplWatcher = new XrplWatcher({
        escrowOwner: config.xrpl.escrowOwner,
        onReveal: ({ preimage, tx }) => {
          this.log("preimagen revelada en XRPL, tx:", tx.hash ?? "(hash en meta)");
          this.log("sha256:", bt.sorobanSecretHash(preimage).toString("hex"));
          config.onSorobanClaimNeeded?.(preimage);
        },
      });
      await this.xrplWatcher.start();
      this.log("observando XRPL, cuenta:", config.xrpl.escrowOwner);
    }
  }

  /** Envía EscrowFinish en XRPL con la preimagen revelada en Soroban. */
  async completeXrplLeg(preimage) {
    const { escrowOwner, offerSequence, relayWallet } = this.config.xrpl;
    const client = new xrpl.Client(this.config.xrpl.server ?? XRPL_TESTNET);
    await client.connect();
    try {
      const res = await client.submitAndWait(
        {
          TransactionType: "EscrowFinish",
          Account: relayWallet.address,
          SourceTag: bt.SOURCE_TAG,
          Owner: escrowOwner,
          OfferSequence: offerSequence,
          Condition: bt.xrplCondition(preimage),
          Fulfillment: bt.xrplFulfillment(preimage),
        },
        { autofill: true, wallet: relayWallet }
      );
      this.log("EscrowFinish XRPL:", res.result.meta.TransactionResult);
      return res;
    } finally {
      await client.disconnect();
    }
  }

  async stop() {
    await this.xrplWatcher?.stop();
    await this.sorobanWatcher?.stop();
  }
}

module.exports = { Relay, XrplWatcher, SorobanWatcher, extractPreimage, findRevealedPreimage };
