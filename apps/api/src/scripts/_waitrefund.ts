import { execFileSync } from "child_process";
import { rpc } from "@stellar/stellar-sdk";
import { refundSwap } from "../lib/soroban.js";
import { swapStore } from "../lib/swapStore.js";

const CONTRACT_A = "CANNVHGZHVSVQO76SIVV5YNHH6ODDBV5IEROUITFTFIH6NRLF7XHRCIT";
const sec = (a: string) => execFileSync("stellar", ["keys", "show", a], { encoding: "utf8" }).trim();
const TIMEOUT_LEDGER = 4021415;

async function main() {
  const server = new rpc.Server("https://soroban-testnet.stellar.org");
  for (;;) {
    const { sequence } = await server.getLatestLedger();
    if (sequence > TIMEOUT_LEDGER) { console.log(`ledger ${sequence} > ${TIMEOUT_LEDGER}, reintentando`); break; }
    console.log(`ledger ${sequence}, faltan ${TIMEOUT_LEDGER - sequence}`);
    await new Promise((r) => setTimeout(r, 30000));
  }

  const id = "colgado";
  const now = new Date().toISOString();
  swapStore.set(id, {
    swap_id: id, plan_id: "ataque", status: "refund_pending",
    sell_asset: "XLM", sell_amount: "0.1", buy_asset: "XRP", buy_amount: "2",
    chain_b: "xrpl",
    secret_hash: "fdf4ba0f3e7e25b45820a882cd04bf438dfe3aa6a2ee7881230595474ba14f29",
    txs: {
      lock_a: "df7300ac270a8a836fb2026c5d5b464f0b37fb1b63519c148c477427f7a3a654",
      lock_b: "B1AFBB86068015A4F2102953A8526BF28879984E0AF102905FD1CFEA49748999",
      refund_b: "AA01EBDDB9B59A8E9E709A09BD81C3855A63E23E05486B40A85CB54B1E4E2D06",
    },
    created_at: now, updated_at: now,
  });

  const r = await refundSwap(id, sec("raul-bridge"), CONTRACT_A, { initiatorSeed: "x", counterpartySeed: "x" });
  console.log("reembolsado:", r.refunded);
  console.log("pendiente  :", r.pending);
  console.log("estado     :", swapStore.get(id)!.status);
  console.log("refund_a   :", swapStore.get(id)!.txs.refund_a);
  const st = execFileSync("stellar", ["contract","invoke","--id",CONTRACT_A,"--source","raul-bridge","--network","testnet","--","get_status","--swap_id","416581bebd662d0c161555cfb7dcd7ce1912375b0d8aaed3091f16a0ffabe7cb"], { encoding: "utf8" });
  console.log("estado on-chain:", st.trim());
}
main().catch((e) => { console.error(e); process.exit(1); });
