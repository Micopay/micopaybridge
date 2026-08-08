/**
 * /api/v1/swaps/execute perdía counterparty_address al guardar el plan en
 * planStore (agent.ts). validatePlan() se corre otra vez en /execute como
 * doble check, y con el campo en undefined tiraba 500 "Invalid
 * counterparty_address" en TODA ejecución — incluida la del botón de la
 * consola (SwapStatus.tsx), que llama exactamente esta ruta HTTP. No lo
 * atrapaba test:live porque ese script llama executeAtomicSwapBackground
 * directo, sin pasar por /plan ni /execute.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "../index.js";
import { planStore } from "../lib/swapStore.js";
import type { FastifyInstance } from "fastify";

const DEMO_AGENT_ADDRESS_PLACEHOLDER = "GDEMOAGENTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

describe("POST /api/v1/swaps/execute — counterparty_address persistido", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.X402_MOCK_MODE = "true";
    app = await createApp();
  });
  afterEach(async () => { await app.close(); });

  it("no revienta con 'Invalid counterparty_address' para un plan recién creado", async () => {
    planStore.set("plan_test_execute", {
      id: "plan_test_execute",
      sell_asset: "USDC",
      sell_amount: "1",
      buy_asset: "XRP",
      buy_amount: "1",
      exchange_rate: "1",
      counterparty_address: DEMO_AGENT_ADDRESS_PLACEHOLDER,
      initiator_ledgers: 240,
      counterparty_ledgers: 120,
      risk_level: "medium",
      estimated_time_seconds: 120,
      created_at: new Date().toISOString(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/swaps/execute",
      headers: { "x-payment": "mock:GTEST_EXEC:0.05", "content-type": "application/json" },
      payload: { plan_id: "plan_test_execute" },
    });

    // Sin PLATFORM_SECRET_KEY/DEMO_AGENT_SECRET_KEY/XRPL seeds configuradas,
    // el siguiente gate real es 503 "Demo keypairs not configured". Lo que
    // importa aquí es que YA NO sea 500 por counterparty_address.
    expect(res.statusCode).not.toBe(500);
    expect(res.body).not.toContain("Invalid counterparty_address");
    expect(res.statusCode).toBe(503);
  });
});
