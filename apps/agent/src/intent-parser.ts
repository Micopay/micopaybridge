import Anthropic from "@anthropic-ai/sdk";
import type { SwapPlan } from "@micopay/types";
import { SWAP_AGENT_SYSTEM_PROMPT } from "./prompts/system.js";
import { SWAP_TOOLS, executeTool } from "./tools.js";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4096;

/**
 * Intent Parser — the only place Claude is used.
 *
 * Takes natural language input and produces a structured SwapPlan.
 * Claude calls tools to gather real data (prices, reputation, counterparties)
 * before producing the final plan.
 *
 * IMPORTANT: This function produces a PLAN. It does NOT execute anything.
 * Execution happens in executor.ts with zero LLM involvement.
 */
export async function planSwap(
  intent: string,
  userAddress: string
): Promise<SwapPlan> {
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Usuario: ${intent}\nStellar address: ${userAddress}\n\nPor favor analiza la intención, consulta el estado real usando las tools, y genera un SwapPlan ejecutable.`,
    },
  ];

  let finalPlanInput: Record<string, unknown> | null = null;

  // Agentic loop — Claude can call tools multiple times before finalizing
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SWAP_AGENT_SYSTEM_PROMPT,
      tools: SWAP_TOOLS,
      messages,
    });

    // Add assistant response to conversation
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      // Claude finished without calling create_swap_plan — shouldn't happen
      // but handle gracefully
      break;
    }

    if (response.stop_reason === "tool_use") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        // Capture the final plan when Claude calls create_swap_plan
        if (block.name === "create_swap_plan") {
          finalPlanInput = block.input as Record<string, unknown>;
        }

        const result = await executeTool(
          block.name,
          block.input as Record<string, unknown>
        );

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      }

      messages.push({ role: "user", content: toolResults });

      // If we captured the plan, we're done
      if (finalPlanInput) break;

      continue;
    }

    // Any other stop reason — break
    break;
  }

  if (!finalPlanInput) {
    throw new Error("Agent did not produce a swap plan");
  }

  return buildSwapPlan(finalPlanInput, userAddress);
}

/**
 * Convert Claude's create_swap_plan tool input into a typed SwapPlan.
 */
function buildSwapPlan(
  input: Record<string, unknown>,
  userAddress: string
): SwapPlan {
  const initiatorLedgers = Number(input.initiator_ledgers ?? 240);
  const counterpartyLedgers = Number(input.counterparty_ledgers ?? 120);

  // Safety check: initiator must always be > counterparty
  const safeInitiator = Math.max(initiatorLedgers, counterpartyLedgers * 2);

  return {
    id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    steps: [
      {
        order: 1,
        action: "lock",
        chain: "stellar",
        contract: "atomic_swap",
        params: {
          initiator: userAddress,
          counterparty: String(input.counterparty_address),
          sell_asset: String(input.sell_asset),
          sell_amount: String(input.sell_amount),
          timeout_ledgers: safeInitiator,
        },
      },
      {
        order: 2,
        action: "monitor",
        chain: String(input.counterparty_chain ?? "stellar"),
        contract: "atomic_swap",
        params: {
          expected_secret_hash: "__derived_from_step_1__",
          timeout_ledgers: counterpartyLedgers,
        },
        depends_on: 1,
      },
      {
        order: 3,
        action: "release",
        chain: String(input.counterparty_chain ?? "stellar"),
        contract: "atomic_swap",
        params: {
          buy_asset: String(input.buy_asset),
          buy_amount: String(input.buy_amount),
        },
        depends_on: 2,
      },
    ],
    counterparty: {
      address: String(input.counterparty_address),
      chain: String(input.counterparty_chain ?? "stellar"),
      reputation_score: Number(input.counterparty_reputation_score ?? 80),
    },
    amounts: {
      sell_asset: String(input.sell_asset),
      sell_amount: String(input.sell_amount),
      buy_asset: String(input.buy_asset),
      buy_amount: String(input.buy_amount),
      exchange_rate: String(input.exchange_rate ?? "1.0"),
    },
    timeouts: {
      initiator_ledgers: safeInitiator,
      counterparty_ledgers: counterpartyLedgers,
    },
    fees: {
      gas_chain_a: "0.001",
      gas_chain_b: "0.001",
      service_fee: "0.01",
      total_usd: String(input.total_fee_usd ?? "0.012"),
    },
    risk_level: (String(input.risk_level ?? "medium")) as "low" | "medium" | "high",
    estimated_time_seconds: Number(input.estimated_time_seconds ?? 120),
  };
}
