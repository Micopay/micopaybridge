import type Anthropic from "@anthropic-ai/sdk";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3000";

// x402 mock payment header for internal agent calls (agent pays for its own queries)
const AGENT_PAYMENT_HEADER = `mock:${process.env.AGENT_STELLAR_ADDRESS ?? "GAGENT_INTERNAL"}:0.001`;

/**
 * Tool definitions for the Claude swap planning agent.
 * These are the tools Claude can call to gather real data before planning.
 */
export const SWAP_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_swaps",
    description:
      "Busca contrapartes disponibles para un atomic swap. Devuelve lista con score, rate, y available_amount.",
    input_schema: {
      type: "object" as const,
      properties: {
        sell_asset: {
          type: "string",
          description: "Asset a vender (USDC, XLM, MXNe)",
        },
        buy_asset: {
          type: "string",
          description: "Asset a comprar (XLM, USDC, ETH)",
        },
        amount: {
          type: "number",
          description: "Monto a vender",
        },
      },
      required: ["sell_asset", "buy_asset", "amount"],
    },
  },
  {
    name: "calculate_timeouts",
    description:
      "Calcula timeouts óptimos en ledgers para un swap. initiator_ledgers siempre > counterparty_ledgers.",
    input_schema: {
      type: "object" as const,
      properties: {
        chain_a: { type: "string", description: "Cadena A (siempre 'stellar')" },
        chain_b: { type: "string", description: "Cadena B destino" },
        amount_usd: { type: "number", description: "Monto en USD" },
      },
      required: ["chain_a", "chain_b"],
    },
  },
  {
    name: "create_swap_plan",
    description:
      "Genera el plan final de ejecución. Llama esto SIEMPRE al terminar de recopilar datos.",
    input_schema: {
      type: "object" as const,
      properties: {
        counterparty_address: { type: "string" },
        counterparty_chain: { type: "string" },
        sell_asset: { type: "string" },
        sell_amount: { type: "string" },
        buy_asset: { type: "string" },
        buy_amount: { type: "string" },
        exchange_rate: { type: "string" },
        initiator_ledgers: { type: "number" },
        counterparty_ledgers: { type: "number" },
        total_fee_usd: { type: "string" },
        estimated_time_seconds: { type: "number" },
        risk_level: {
          type: "string",
          enum: ["low", "medium", "high"],
        },
      },
      required: [
        "counterparty_address",
        "counterparty_chain",
        "sell_asset",
        "sell_amount",
        "buy_asset",
        "buy_amount",
        "initiator_ledgers",
        "counterparty_ledgers",
        "total_fee_usd",
        "estimated_time_seconds",
        "risk_level",
      ],
    },
  },
];

/**
 * Execute a tool call from Claude and return the result as a string.
 */
export async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<string> {
  try {
    switch (toolName) {
      case "search_swaps": {
        const params = new URLSearchParams({
          sell_asset: String(toolInput.sell_asset ?? "USDC"),
          buy_asset: String(toolInput.buy_asset ?? "XLM"),
          amount: String(toolInput.amount ?? "0"),
        });
        const res = await fetch(`${API_BASE}/api/v1/swaps/search?${params}`, {
          headers: { "x-payment": AGENT_PAYMENT_HEADER },
        });
        const data = await res.json();
        return JSON.stringify(data);
      }

      case "calculate_timeouts": {
        // Heuristic: base timeouts + buffer for amount
        const amountUsd = Number(toolInput.amount_usd ?? 10);
        const baseCounterparty = 120; // ~10 min at 5s/ledger
        const buffer = amountUsd > 100 ? 60 : 0;
        const counterparty = baseCounterparty + buffer;
        const initiator = counterparty * 2; // always 2x
        return JSON.stringify({
          chain_a: toolInput.chain_a,
          chain_b: toolInput.chain_b,
          initiator_ledgers: initiator,
          counterparty_ledgers: counterparty,
          note: "initiator_ledgers is always 2x counterparty_ledgers for safety",
        });
      }

      case "create_swap_plan":
        // This tool just captures Claude's final plan — return it as-is
        return JSON.stringify({ ok: true, plan_captured: true });

      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  } catch (err) {
    return JSON.stringify({ error: String(err) });
  }
}
