import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { requirePayment } from "../middleware/x402.js";
import { planStore, swapStore } from "../lib/swapStore.js";
import { executeAtomicSwapBackground } from "../lib/soroban.js";

const CONTRACT_A = process.env.ATOMIC_SWAP_CONTRACT_A ?? "CCDOUXIXSFXT2HTJAJGFNUJN6CKCYX2M6AL2BHHPEF6ISNHP2BGLS4KX";
const CONTRACT_B = process.env.ATOMIC_SWAP_CONTRACT_B ?? "CBLCGG44QQILWEIVBXDSZSLH7NI7SGJQKXQ7WTKP3W3YSXOBTGMZKSNN";

const ALLOWED_ASSETS = new Set(["USDC", "XLM", "MXNe"]);
const MAX_AMOUNT_USD = 100; // Maximum amount per swap (USD)
const DEMO_AGENT_ADDRESS = process.env.DEMO_AGENT_PUBLIC_KEY ?? "GDEMOAGENTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Placeholder, should be set in env

const SYSTEM_PROMPT = `
Eres el agente de atomic swaps de Micopay Protocol.

Tu trabajo es entender la intención del usuario y producir un SwapPlan ejecutable.
Operas sobre Stellar testnet. Los atomic swaps son cross-chain: el usuario bloquea
fondos en Stellar y la contraparte bloquea en la cadena destino (o en un segundo
contrato HTLC en testnet para el demo).

## Reglas estrictas

1. SIEMPRE usa las tools para consultar estado real antes de planificar.
   Nunca asumas precios o disponibilidad.
2. El plan debe ser un JSON ejecutable — no una descripción en prosa.
3. Si no hay contrapartes disponibles, responde con un error claro.
4. El timeout del initiator SIEMPRE debe ser mayor al del counterparty.
   Regla mínima: initiator_ledgers = counterparty_ledgers * 2
5. Incluye siempre el fee total estimado en el plan.
6. risk_level = "high" si completion_rate < 0.85.

## Assets soportados
- Stellar: USDC, XLM, MXNe

## Tasas de mercado (SIEMPRE usa el rate que devuelve search_swaps — viene de Horizon en tiempo real)
El campo "rate" en los counterparties es cuántos buy_asset recibes por cada sell_asset.
buy_amount = sell_amount × rate
Ejemplo: sell 50 USDC, rate = 6.12 → buy_amount = "306.0" XLM

## Flujo de un atomic swap
1. Initiator bloquea en Stellar con secret_hash = sha256(secret)
2. Counterparty bloquea con el mismo secret_hash
3. Initiator revela el secret (cobra)
4. El secret queda público en los eventos

SIEMPRE termina usando la tool create_swap_plan con el plan completo.
`.trim();

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_swaps",
    description: "Busca contrapartes disponibles para un atomic swap.",
    input_schema: {
      type: "object" as const,
      properties: {
        sell_asset: { type: "string" },
        buy_asset: { type: "string" },
        amount: { type: "number" },
      },
      required: ["sell_asset", "buy_asset", "amount"],
    },
  },
  {
    name: "calculate_timeouts",
    description: "Calcula timeouts óptimos en ledgers. initiator siempre > counterparty.",
    input_schema: {
      type: "object" as const,
      properties: {
        chain_a: { type: "string" },
        chain_b: { type: "string" },
        amount_usd: { type: "number" },
      },
      required: ["chain_a", "chain_b"],
    },
  },
  {
    name: "create_swap_plan",
    description: "Genera el plan final de ejecución. Llama esto SIEMPRE al terminar.",
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
        risk_level: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: [
        "counterparty_address", "counterparty_chain", "sell_asset", "sell_amount",
        "buy_asset", "buy_amount", "initiator_ledgers", "counterparty_ledgers",
        "total_fee_usd", "estimated_time_seconds", "risk_level",
      ],
    },
  },
];

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  apiBase: string
): Promise<string> {
  const paymentHeader = "mock:GAGENT_INTERNAL:0.001";
  try {
    switch (name) {
      case "search_swaps": {
        const params = new URLSearchParams({
          sell_asset: String(input.sell_asset ?? "USDC"),
          buy_asset: String(input.buy_asset ?? "XLM"),
          amount: String(input.amount ?? "0"),
        });
        const res = await fetch(`${apiBase}/api/v1/swaps/search?${params}`, {
          headers: { "x-payment": paymentHeader },
        });
        return JSON.stringify(await res.json());
      }
      case "calculate_timeouts": {
        const amountUsd = Number(input.amount_usd ?? 10);
        const counterparty = 120 + (amountUsd > 100 ? 60 : 0);
        return JSON.stringify({
          initiator_ledgers: counterparty * 2,
          counterparty_ledgers: counterparty,
          note: "initiator = 2x counterparty for safety",
        });
      }
      case "create_swap_plan":
        return JSON.stringify({ ok: true });
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: String(err) });
  }
}

function validatePlan(plan: any): void {
  // Validate assets are allowed
  if (!ALLOWED_ASSETS.has(plan.sell_asset)) {
    throw new Error(`Invalid sell_asset: ${plan.sell_asset}. Allowed assets: ${Array.from(ALLOWED_ASSETS).join(", ")}`);
  }
  if (!ALLOWED_ASSETS.has(plan.buy_asset)) {
    throw new Error(`Invalid buy_asset: ${plan.buy_asset}. Allowed assets: ${Array.from(ALLOWED_ASSETS).join(", ")}`);
  }

  // Validate amounts
  const sellAmountNum = parseFloat(plan.sell_amount);
  const buyAmountNum = parseFloat(plan.buy_amount);
  if (isNaN(sellAmountNum) || sellAmountNum <= 0) {
    throw new Error(`Invalid sell_amount: ${plan.sell_amount}`);
  }
  if (isNaN(buyAmountNum) || buyAmountNum <= 0) {
    throw new Error(`Invalid buy_amount: ${plan.buy_amount}`);
  }

  // Simple USD estimate for max amount check
  const estimatedUsd = (plan.sell_asset === "USDC" ? sellAmountNum : 
                         plan.sell_asset === "XLM" ? sellAmountNum * 0.1 : sellAmountNum * 0.05); // Rough estimates
  if (estimatedUsd > MAX_AMOUNT_USD) {
    throw new Error(`Amount exceeds maximum allowed (${MAX_AMOUNT_USD} USD)`);
  }

  // Validate counterparty address (in demo mode, should match expected counterparty)
  if (DEMO_AGENT_ADDRESS && plan.counterparty_address !== DEMO_AGENT_ADDRESS) {
    throw new Error(`Invalid counterparty_address`);
  }
}

async function planSwap(
  intent: string,
  userAddress: string,
  apiBase: string
): Promise<Record<string, unknown>> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Usuario: ${intent}\nStellar address: ${userAddress}\n\nAnaliza la intención y genera un SwapPlan ejecutable.`,
    },
  ];

  let finalPlan: Record<string, unknown> | null = null;

  while (true) {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "tool_use") {
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        if (block.name === "create_swap_plan") {
          finalPlan = block.input as Record<string, unknown>;
        }
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: await executeTool(block.name, block.input as Record<string, unknown>, apiBase),
        });
      }
      messages.push({ role: "user", content: results });
      if (finalPlan) break;
      continue;
    }
    break;
  }

  if (!finalPlan) throw new Error("Agent did not produce a swap plan");

  const initiator = Math.max(Number(finalPlan.initiator_ledgers ?? 240), Number(finalPlan.counterparty_ledgers ?? 120) * 2);

  return {
    id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    steps: [
      { order: 1, action: "lock", chain: "stellar", contract: "atomic_swap", params: { initiator: userAddress, counterparty: finalPlan.counterparty_address, sell_asset: finalPlan.sell_asset, sell_amount: finalPlan.sell_amount, timeout_ledgers: initiator } },
      { order: 2, action: "monitor", chain: String(finalPlan.counterparty_chain ?? "stellar"), contract: "atomic_swap", params: { timeout_ledgers: finalPlan.counterparty_ledgers }, depends_on: 1 },
      { order: 3, action: "release", chain: String(finalPlan.counterparty_chain ?? "stellar"), contract: "atomic_swap", params: { buy_asset: finalPlan.buy_asset, buy_amount: finalPlan.buy_amount }, depends_on: 2 },
    ],
    counterparty: { address: finalPlan.counterparty_address, chain: finalPlan.counterparty_chain ?? "stellar" },
    amounts: { sell_asset: finalPlan.sell_asset, sell_amount: finalPlan.sell_amount, buy_asset: finalPlan.buy_asset, buy_amount: finalPlan.buy_amount, exchange_rate: finalPlan.exchange_rate ?? "1.0" },
    timeouts: { initiator_ledgers: initiator, counterparty_ledgers: finalPlan.counterparty_ledgers },
    fees: { gas_chain_a: "0.001", gas_chain_b: "0.001", service_fee: "0.01", total_usd: finalPlan.total_fee_usd ?? "0.012" },
    risk_level: finalPlan.risk_level ?? "medium",
    estimated_time_seconds: finalPlan.estimated_time_seconds ?? 120,
  };
}

export async function agentRoutes(fastify: FastifyInstance): Promise<void> {
  const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3000";

  /**
   * POST /api/v1/swaps/plan
   * x402: $0.01 — Claude (Haiku) parses intent and produces a SwapPlan
   */
  fastify.post(
    "/api/v1/swaps/plan",
    { preHandler: requirePayment({ amount: "0.01", service: "swap_plan" }) },
    async (request, reply) => {
      const body = request.body as { intent: string; user_address: string };

      if (!body?.intent) {
        return reply.status(400).send({ error: "intent is required" });
      }

      if (!process.env.ANTHROPIC_API_KEY) {
        return reply.status(503).send({ error: "Agent not configured — ANTHROPIC_API_KEY missing" });
      }

      try {
        const plan = await planSwap(body.intent, body.user_address ?? "GUNKOWN", API_BASE);

        // Validate the plan before storing
        const planToValidate = {
          sell_asset: (plan.amounts as any).sell_asset,
          sell_amount: (plan.amounts as any).sell_amount,
          buy_asset: (plan.amounts as any).buy_asset,
          buy_amount: (plan.amounts as any).buy_amount,
          counterparty_address: (plan.counterparty as any).address,
        };
        validatePlan(planToValidate);

        // Store plan so execute can retrieve it by plan_id
        planStore.set(plan.id as string, {
          id:                   plan.id as string,
          sell_asset:           (plan.amounts as any).sell_asset,
          sell_amount:          (plan.amounts as any).sell_amount,
          buy_asset:            (plan.amounts as any).buy_asset,
          buy_amount:           (plan.amounts as any).buy_amount,
          exchange_rate:        (plan.amounts as any).exchange_rate ?? "0",
          initiator_ledgers:    (plan.timeouts as any).initiator_ledgers,
          counterparty_ledgers: (plan.timeouts as any).counterparty_ledgers,
          risk_level:           plan.risk_level as string,
          estimated_time_seconds: plan.estimated_time_seconds as number,
          created_at:           new Date().toISOString(),
        });

        return reply.send({ plan, payer: request.payerAddress, agent: "claude-haiku-4-5" });
      } catch (err) {
        fastify.log.error(err);
        return reply.status(500).send({ error: "Agent failed", detail: String(err) });
      }
    }
  );

  /**
   * POST /api/v1/swaps/execute
   * x402: $0.05 — execute a previously created SwapPlan
   */
  fastify.post(
    "/api/v1/swaps/execute",
    { preHandler: requirePayment({ amount: "0.05", service: "swap_execute" }) },
    async (request, reply) => {
      const body = request.body as { plan_id: string; user_address?: string };

      if (!body?.plan_id) {
        return reply.status(400).send({ error: "plan_id is required" });
      }

      const plan = planStore.get(body.plan_id);
      if (!plan) {
        return reply.status(404).send({ error: "plan_id not found — call /api/v1/swaps/plan first" });
      }

      // Validate the plan before execution (double check!)
      validatePlan(plan);

      const initiatorSecret    = process.env.PLATFORM_SECRET_KEY;
      const counterpartySecret = process.env.DEMO_AGENT_SECRET_KEY;
      if (!initiatorSecret || !counterpartySecret) {
        return reply.status(503).send({ error: "Demo keypairs not configured" });
      }

      const swapId = `swap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const now    = new Date().toISOString();

      // Register swap in store immediately
      swapStore.set(swapId, {
        swap_id:     swapId,
        plan_id:     plan.id,
        status:      "queued",
        sell_asset:  plan.sell_asset,
        sell_amount: plan.sell_amount,
        buy_asset:   plan.buy_asset,
        buy_amount:  plan.buy_amount,
        txs:         {},
        created_at:  now,
        updated_at:  now,
      });

      // Run the 4 contract calls in background — do NOT await
      executeAtomicSwapBackground(
        swapId,
        initiatorSecret,
        counterpartySecret,
        CONTRACT_A,
        CONTRACT_B,
        plan.sell_asset,
        parseFloat(plan.sell_amount),
        plan.buy_asset,
        parseFloat(plan.buy_amount),
        plan.initiator_ledgers,
        plan.counterparty_ledgers,
      ).catch((err) => fastify.log.error("Swap execution error:", err));

      return reply.status(202).send({
        swap_id:    swapId,
        plan_id:    plan.id,
        status:     "queued",
        sell:       `${plan.sell_amount} ${plan.sell_asset}`,
        buy:        `${plan.buy_amount} ${plan.buy_asset}`,
        payer:      request.payerAddress,
        message:    "Swap queued. Poll GET /api/v1/swaps/:id/status for live progress.",
        poll_url:   `/api/v1/swaps/${swapId}/status`,
      });
    }
  );
}
