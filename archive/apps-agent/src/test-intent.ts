/**
 * Test the intent parser with example intents.
 * Run: npm test (from apps/agent/)
 *
 * Requires: ANTHROPIC_API_KEY in environment
 */
import { planSwap } from "./intent-parser.js";

const TEST_ADDRESS = "GDEMOUSER1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

const TEST_INTENTS = [
  "quiero cambiar 50 USDC por XLM",
  "tengo 100 USDC y quiero obtener lo máximo posible en XLM",
  "necesito hacer un swap rápido de 10 USDC",
];

async function runTests() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("❌ ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  for (const intent of TEST_INTENTS) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Intent: "${intent}"`);
    console.log("=".repeat(60));

    try {
      const plan = await planSwap(intent, TEST_ADDRESS);
      console.log("✅ Plan generated:");
      console.log(JSON.stringify(plan, null, 2));
    } catch (err) {
      console.error("❌ Failed:", err);
    }
  }
}

runTests();
