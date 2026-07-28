// Agente B (maker) — MicoPay Bridge demo autónomo.
//
// Servidor HTTP estilo AIGENTS/x402: publica catálogo de servicios
// (mismo shape que packages/types/src/agent.ts del repo micopay-protocol;
// cobro x402 apagado en demo, price_usdc: "0").
//
// Flujo autónomo de B:
//   1. /catalog        — descubrimiento
//   2. /swap/propose   — cotiza XLM→XRP y entrega sus direcciones
//   3. /swap/lock-notify — A avisa que bloqueó en Soroban; B VERIFICA
//      on-chain (get_swap: hash, contraparte, monto, invariante de tiempo)
//      y solo entonces bloquea 5 XRP en escrow XRPL bajo el mismo hash.
//   4. Watcher XRPL propio: cuando A reclama revelando la preimagen,
//      B llama release() en Soroban con el secreto y cobra su XLM.

const http = require("http");
const { execFileSync } = require("child_process");
const xrpl = require("xrpl");
const { rpc } = require("@stellar/stellar-sdk");
const bt = require("./bridge-translate");
const { XrplWatcher } = require("./relay");

const PORT = 4021;
const CONTRACT_ID = "CANNVHGZHVSVQO76SIVV5YNHH6ODDBV5IEROUITFTFIH6NRLF7XHRCIT";
const IDENTITY = "mota-agent";
const RATE_XRP_PER_XLM = 5;

const log = (...a) => console.log("[agente-B]", ...a);

const stellarCli = (...args) => {
  const sep = args.indexOf("--");
  const full = sep === -1 ? [...args, "--network", "testnet"] : [...args.slice(0, sep), "--network", "testnet", ...args.slice(sep)];
  return execFileSync("stellar", full, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
};

const state = {}; // proposal_id -> datos del swap

async function main() {
  const sorobanAddress = execFileSync("stellar", ["keys", "address", IDENTITY], { encoding: "utf8" }).trim();
  const soroban = new rpc.Server("https://soroban-testnet.stellar.org");

  const client = new xrpl.Client("wss://s.altnet.rippletest.net:51233");
  await client.connect();
  const { wallet } = await client.fundWallet();
  log("Soroban:", sorobanAddress);
  log("XRPL:", wallet.address);

  const routes = {
    "GET /catalog": async () => ({
      protocol: "micopay",
      version: "0.1.0",
      payment_method: "x402",
      payment_asset: "USDC",
      payment_network: "stellar",
      services: [
        {
          name: "swap-xlm-xrp",
          endpoint: "/swap/propose",
          method: "POST",
          price_usdc: "0",
          description: `Atomic swap XLM (Soroban) -> XRP (XRPL), tasa ${RATE_XRP_PER_XLM} XRP/XLM`,
        },
      ],
      skill_url: "",
    }),

    "POST /swap/propose": async (body) => {
      if (body.sell_asset !== "XLM" || body.buy_asset !== "XRP") throw new Error("Par no soportado");
      const proposalId = bt.generatePreimage().toString("hex").slice(0, 16);
      state[proposalId] = { xlm: body.sell_amount, xrp: body.sell_amount * RATE_XRP_PER_XLM };
      log(`propuesta ${proposalId}: ${body.sell_amount} XLM -> ${state[proposalId].xrp} XRP`);
      return {
        proposal_id: proposalId,
        quote: { xrp_amount: state[proposalId].xrp },
        soroban_address: sorobanAddress,
        xrpl_address: wallet.address,
      };
    },

    "POST /swap/lock-notify": async (body) => {
      const p = state[body.proposal_id];
      if (!p) throw new Error("Propuesta desconocida");

      // Verificación on-chain del lock de A — cero confianza en el mensaje
      const swapJson = JSON.parse(
        stellarCli("contract", "invoke", "--id", CONTRACT_ID, "--source", IDENTITY, "--", "get_swap", "--swap_id", body.swap_id)
      );
      if (swapJson.counterparty !== sorobanAddress) throw new Error("Lock no me tiene de contraparte");
      if (swapJson.secret_hash !== body.secret_hash) throw new Error("secret_hash no coincide con el lock");
      if (BigInt(swapJson.amount) < BigInt(p.xlm * 10_000_000)) throw new Error("Monto bloqueado insuficiente");
      if (swapJson.status !== "Locked") throw new Error("Swap no está Locked");

      // Invariante: mi timeout (contraparte) < timeout de A (iniciador)
      const { sequence: currentLedger } = await soroban.getLatestLedger();
      const initiatorMarginSec = (swapJson.timeout_ledger - currentLedger) * bt.STELLAR_SECONDS_PER_LEDGER;
      const myMarginSec = Math.floor(initiatorMarginSec / 2);
      if (!bt.checkInvariant(initiatorMarginSec, myMarginSec)) throw new Error("Invariante de tiempo violada");
      log(`lock verificado on-chain (${swapJson.amount} stroops, margen A ${initiatorMarginSec}s, mío ${myMarginSec}s)`);

      // Bloquear pierna XRPL bajo el MISMO hash (B nunca conoce la preimagen)
      const hash = Buffer.from(body.secret_hash, "hex");
      const condition = bt.xrplConditionFromHash(hash);
      const create = await client.submitAndWait(
        {
          TransactionType: "EscrowCreate",
          Account: wallet.address,
          SourceTag: bt.SOURCE_TAG,
          Destination: body.xrpl_address,
          Amount: xrpl.xrpToDrops(String(p.xrp)),
          Condition: condition,
          CancelAfter: bt.toRippleTime(Math.floor(Date.now() / 1000) + myMarginSec),
        },
        { autofill: true, wallet }
      );
      if (create.result.meta.TransactionResult !== "tesSUCCESS") throw new Error("EscrowCreate falló");
      log(`bloqueados ${p.xrp} XRP hacia ${body.xrpl_address}`);

      // Watcher: cuando A revele la preimagen al reclamar, B cobra en Soroban
      const watcher = new XrplWatcher({
        escrowOwner: wallet.address,
        onReveal: async ({ preimage }) => {
          log("preimagen revelada en XRPL — reclamando mi XLM en Soroban");
          stellarCli(
            "contract", "invoke", "--id", CONTRACT_ID, "--source", IDENTITY, "--",
            "release", "--swap_id", body.swap_id, "--secret", preimage.toString("hex")
          );
          log("release() OK — swap completo de mi lado. Cerrando.");
          await watcher.stop();
          await client.disconnect();
          server.close();
          process.exit(0);
        },
      });
      await watcher.start();

      return { escrow: { owner: wallet.address, offer_sequence: create.result.tx_json.Sequence, condition } };
    },
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const key = `${req.method} ${req.url}`;
    try {
      const handler = routes[key];
      if (!handler) throw new Error(`Ruta desconocida: ${key}`);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      const out = await handler(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    } catch (e) {
      log("error:", e.message);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  server.listen(PORT, () => log(`escuchando en http://localhost:${PORT} — esperando agentes`));
}

main().catch((e) => {
  console.error("[agente-B] fatal:", e.message);
  process.exit(1);
});
