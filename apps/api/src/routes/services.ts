import type { FastifyInstance } from "fastify";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function serviceRoutes(fastify: FastifyInstance): Promise<void> {
  const BASE_URL = process.env.API_BASE_URL ?? "https://api.micopay.xyz";
  // `reputation` only serves data (and only charges) when the merchant/cash
  // network is connected. Otherwise the route returns 501 without charging, so
  // it must not be advertised as an active priced service.
  const reputationEnabled = process.env.MICOPAY_CASH_NETWORK_ENABLED === "true";

  /**
   * GET /api/v1/services
   * FREE — agent service discovery
   */
  fastify.get("/api/v1/services", async (_request, reply) => {
    return reply.send({
      protocol: "micopay",
      version: "1.3.0",
      tagline: "The first API that gives AI agents access to physical cash in Mexico",
      payment_method: "x402",
      payment_asset: "USDC",
      payment_network: "stellar", // kept for older integrations reading a single value
      payment_networks: ["stellar", "base"], // every priced endpoint below accepts both — same requirePayment() middleware
      services: [
        {
          name: "cash_agents",
          endpoint: "GET /api/v1/cash/agents",
          method: "GET",
          price_usdc: "0.001",
          description: "Find available cash merchants near a location. Returns merchants sorted by distance with availability, tier, and live USDC/MXN rate.",
          example_request: { lat: "19.4195", lng: "-99.1627", amount: "500", limit: "5" },
          why_pay: "Access to the MicoPay merchant network — no other API can tell you who has physical cash available near you right now.",
        },
        {
          name: "reputation",
          endpoint: "GET /api/v1/reputation/:address",
          method: "GET",
          // Only chargeable when the network is connected; returns 501 otherwise.
          // When disabled, price_usdc is omitted entirely (rather than set to
          // null) so strict string-parsing clients don't break on a type change;
          // `available: false` carries the disabled signal.
          ...(reputationEnabled ? { price_usdc: "0.0005" } : {}),
          available: reputationEnabled,
          status: reputationEnabled ? "active" : "disabled",
          description: "Verify a merchant's on-chain reputation before sending your user there. Returns tier, completion rate, trade history, and NFT soulbound badge.",
          note: reputationEnabled ? undefined : "Disabled: returns 501 until MICOPAY_CASH_NETWORK_ENABLED=true. Not charged while disabled.",
          example_request: { address: "GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG" },
          why_pay: "Reputation is the only signal an AI agent has before trusting a stranger with cash. This data is on-chain and cannot be faked.",
        },
        {
          name: "cash_request",
          endpoint: "POST /api/v1/cash/request",
          method: "POST",
          price_usdc: "0.01",
          description: "Initiate a USDC → MXN physical cash exchange with a merchant. Locks USDC in an HTLC on Soroban. Returns QR code for the user.",
          example_request: { merchant_address: "GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG", amount_mxn: 500 },
          why_pay: "This triggers a real on-chain HTLC lock. The merchant is notified. USDC is secured by contract until the user collects the cash.",
        },
        {
          name: "bazaar_intent",
          endpoint: "POST /api/v1/bazaar/intent",
          method: "POST",
          price_usdc: "0.005",
          description: "Broadcast a cross-chain swap intent to the global agent social layer. Use this to find agents willing to bridge assets trustlessly.",
          example_request: { offered: { chain: "ethereum", symbol: "ETH", amount: "1.2" }, wanted: { chain: "stellar", symbol: "USDC", amount: "3200" } },
          why_pay: "Broadcasts your intent to all specialized agents in the network. Prevents spam and ensures high-quality signal for market makers.",
        },
        {
          name: "bazaar_feed",
          endpoint: "GET /api/v1/bazaar/feed",
          method: "GET",
          price_usdc: "0.001",
          description: "Scan the global intent feed for opportunities. Returns latest active swap intents from other agents.",
          example_request: {},
          why_pay: "Access to private market data. Agents pay to discover arbitrage and fulfillment opportunities in the network.",
        },
        {
          name: "bazaar_quote",
          endpoint: "POST /api/v1/bazaar/quote",
          method: "POST",
          price_usdc: "0.002",
          description: "Send a private, signed quote to an agent who broadcasted an intent. Initiates the HTLC handshake.",
          example_request: { intent_id: "int-83921", rate: 2840.5 },
          why_pay: "Enables private negotiation channels between agents. Guaranteed delivery of cotizations to the target agent.",
        },
        {
          name: "bazaar_reputation",
          endpoint: "GET /api/v1/bazaar/reputation/:address",
          method: "GET",
          price_usdc: "0",
          description: "Lookup an AI agent's reputation score derived from Bazaar swap history. Returns tier (Maestro/Experto/Activo/Espora), completion rate, and trust signal.",
          example_request: { address: "GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG" },
          why_pay: "Free — use it to filter the intent feed and only respond to trustworthy agents.",
        },
        {
          name: "credential_buy",
          endpoint: "POST /api/v1/credentials/buy",
          method: "POST",
          price_usdc: "0.01",
          description: "Buy an anonymous, single-use access credential (ZK, burn-once on Soroban). Pay once — publicly, on Stellar or Base — spend privately at /api/v1/inference, unlinkable to this purchase.",
          example_request: {},
          why_pay: "Pay-per-use access to Claude inference with no account, no API key, and no way to link which purchase funded which request.",
        },
        {
          name: "inference",
          endpoint: "POST /api/v1/inference",
          method: "POST",
          price_usdc: "0",
          description: "Spend a credential bought at /api/v1/credentials/buy: submit a ZK proof, its nullifier is burned on Soroban (single-use), Claude responds. Not x402-gated directly — the credential IS the proof of payment.",
          example_request: {
            proof: "<base64-encoded UltraHonk proof>",
            public_inputs: ["<merkle_root_dec>", "<nullifier_dec>"],
            prompt: "your prompt here",
          },
          why_pay: "Free to call — you already paid at credential_buy. This is the anonymous spend leg of the pipeline.",
        },
        {
          name: "zk_verify",
          endpoint: "POST /api/v1/zk/verify",
          method: "POST",
          price_usdc: "0.001",
          description: "Verify a zero-knowledge proof on-chain (UltraHonk/BN254 via Soroban). Supported circuits: poseidon_preimage (proof-of-knowledge of a hash pre-image), reputation_v1 (prove reputation tier >= T without revealing identity, address, or exact score).",
          example_request: {
            circuit_id: "reputation_v1",
            proof: "<base64-encoded UltraHonk proof>",
            public_inputs: ["<merkle_root_dec>", "2", "<context_dec>", "<nullifier_dec>"],
          },
          why_pay: "Verify an anonymous counterparty's reputation before locking funds — no identity disclosure, cryptographic proof settled on Soroban. See GET /api/v1/zk/circuits for input specs.",
        },
        {
          name: "fund_micopay",
          endpoint: "POST /api/v1/fund",
          method: "POST",
          price_usdc: "0.10",
          description: "Fund the MicoPay project using x402. Meta-demo: the agent funds the protocol it just used, proving the infrastructure is self-sustaining.",
          example_request: { message: "x402 works!" },
          why_pay: "This IS the demonstration. The protocol finances itself with its own mechanism.",
        },
        {
          name: "swap_search",
          endpoint: "GET /api/v1/swaps/search",
          method: "GET",
          price_usdc: "0.001",
          description: "Find available cross-chain swap counterparties with live Horizon rates.",
          example_request: { from: "XLM", to: "USDC", amount: "100" },
          why_pay: "Live counterparty and rate discovery across chains, priced per lookup.",
        },
        {
          name: "swap_plan",
          endpoint: "POST /api/v1/swaps/plan",
          method: "POST",
          price_usdc: "0.01",
          description: "Turn a natural-language intent into a structured, executable SwapPlan (parsed by Claude).",
          example_request: { intent: "swap 100 XLM for USDC on Stellar" },
          why_pay: "Agent-grade intent parsing into a concrete plan you can execute.",
        },
        {
          name: "swap_execute",
          endpoint: "POST /api/v1/swaps/execute",
          method: "POST",
          price_usdc: "0.05",
          description: "Execute a previously created SwapPlan across chains.",
          example_request: { plan_id: "plan-83921" },
          why_pay: "Executes the real cross-chain swap atomically — the settlement leg.",
        },
        {
          name: "swap_status",
          endpoint: "GET /api/v1/swaps/:id/status",
          method: "GET",
          price_usdc: "0.0001",
          description: "Poll the status of an in-progress swap.",
          example_request: { id: "swap-83921" },
          why_pay: "Cheap status polling for a live swap.",
        },
        {
          name: "bazaar_accept",
          endpoint: "POST /api/v1/bazaar/accept",
          method: "POST",
          price_usdc: "0.005",
          description: "Accept a received quote for your broadcast intent, finalizing the cross-chain HTLC handshake. Requires secret_hash = sha256(preimage) as a 64-char lowercase hex string, generated and kept by the caller (the server never sees the preimage).",
          example_request: {
            intent_id: "int-83921",
            quote_id: "q-1042",
            secret_hash: "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8",
          },
          why_pay: "Commits the deal: locks the HTLC and closes the negotiation with the counterparty agent.",
        },
        {
          name: "cash_request_status",
          endpoint: "GET /api/v1/cash/request/:id",
          method: "GET",
          price_usdc: "0.0001",
          description: "Poll the status of a cash request (merchant, MXN amount, HTLC tx hash, expiry).",
          example_request: { id: "mcr-1a2b3c4d" },
          why_pay: "Exposes sensitive request detail behind payment; request IDs are short and enumerable, so this is deliberately gated (SEC-03).",
        },
      ],
      skill_url: `${BASE_URL}/skill.md`,
      note: "NOT offered: generic USDC/XLM swaps — those exist on Stellar DEX for free. MicoPay only charges for what only MicoPay can do.",
    });
  });

  /**
   * GET /skill.md — OpenClaw SKILL.md for agent discovery
   */
  fastify.get("/skill.md", async (_request, reply) => {
    try {
      const skillPath = join(__dirname, "../../../../skill/SKILL.md");
      const content = readFileSync(skillPath, "utf-8");
      reply.type("text/markdown").send(content);
    } catch {
      reply.status(404).send("SKILL.md not found");
    }
  });
}
