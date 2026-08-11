# MicoPay — Stellar as the Value Hub for the Agentic Economy (Phase 1): Implementation Plan

> ---
> ## ⚠️ COMMERCIAL LAYER / ROADMAP — NOT THIS HACKATHON
> This document describes the **post-hackathon commercial expansion**: accepting payments from Base and Solana agents via CCTP and exposing ZKaaS to the broader x402 economy.
> **The current hackathon demo is Stellar-only.** Base, Solana, CCTP, and pesos are explicitly out of scope for the demo submission. See [`HACKATHON.md`](./HACKATHON.md) for the hackathon one-pager.
> MicoPay is **not a payment intermediary**: fees for our own services land in our wallet; third-party cash settlement (Phase 2) is regulated and deferred.
> ---

> **This is the definitive plan. It supersedes all prior drafts of this file.**
> Audience: a fresh Sonnet agent with no prior context. Self-contained — read §0–§2 fully before coding.
> **Adjusted 2026-06-16** after researching agentic.market — see "What changed" at the bottom.

---

## 🏆 Hackathon framing (read first — this is a STELLAR hackathon)

**Stellar is where the value and the intelligence live. Base and Solana are venues agents reach in FROM.**

The agentic x402 economy (agentic.market) runs on **Base + Solana** — that's where the agents and the
payment volume are. But the things that make agent value *trustworthy and real* belong on **Stellar**:

- **ZK trust** — anonymous reputation/credential verification on **Soroban** (BN254 host functions,
  Protocol 25/26) — aligned with Stellar's own "open by default, private when needed" privacy push.
- **Real-world settlement** — USDC → MXN → **physical pesos / cash in LatAm**, the moat no agent
  marketplace touches.

> **Judge story:** "Agents pay from Base/Solana; MicoPay makes Stellar the destination where that
> payment becomes verified trust (ZK on Soroban) and real-world money (cash in LatAm). Stellar is the
> hub, not another chain competing for agent volume."

The Phase-1 demo must **showcase a Stellar/Soroban service** (ZKaaS) being discovered and paid for from
the agent economy — that is what wins a Stellar hackathon.

---

## The product in one sentence

> **An AI agent pays simple (USDC on Base or Solana — where the x402 volume is). MicoPay verifies and
> settles that value on Stellar (ZK trust on Soroban via CCTP) and, eventually, into physical pesos in
> Mexico. The agent stays single-chain; MicoPay hides the settlement; MicoPay never custodies funds.**

MicoPay is the **bridge between two worlds**: the agent world (digital, automated, on **Base + Solana**)
and the value world (verified trust + real money, on **Stellar**). Base/Solana are the **acquisition
channels**; Stellar is the **home, the moat, and the hackathon showcase**.

---

## 0. Context you MUST load first

### The strategy (decided — do not re-litigate)
- **Stellar is the hub, not "the non-EVM chain for agents."** ⚠️ Correction from earlier drafts:
  **Solana owns ~49% of x402 agent-to-agent volume** — the non-EVM agent chain is Solana, NOT Stellar.
  Stellar's unique value is **ZK trust (Soroban) + real-world LatAm money**, which no marketplace offers.
  Do not position MicoPay as "the non-EVM rail"; position it as "the value/trust/cash destination."
- **MicoPay is its own customer #1.** Our ZKaaS and cash-out are the first paid services that accept
  agents. The infra we build for ourselves becomes the product we sell to others. (AWS/Stripe pattern.)
- **We are infrastructure, NOT a payment processor.** Money flows **directly** to the service's wallet,
  or settles via Circle's CCTP — MicoPay does not sit in the flow of user funds. Receiving payment for
  *our own* service is fine (getting paid ≠ custody). Delivering physical cash to a third person is the
  only money-transmission point → **Phase 2** (regulated).
- **The agent stays single-chain.** It pays on Base or Solana and is done. It never does atomic swaps,
  never manages Stellar keys. We hide all cross-chain settlement behind the API.
- **Capital-light.** CCTP moves USDC from Base AND Solana to Stellar natively — no large inventory.

### Confirmed external facts (verified 2026-06-16)
- **agentic.market = the target market.** A directory of x402 services, pay-per-call USDC, settling on
  **Base + Solana**. Top categories include **inference** (Claude/GPT/DeepSeek/Gemini/Groq + gateways)
  — a confirmed, present demand, not hypothetical. Stellar is **not** a settlement chain there.
- ⚠️ **Solana ≈ 49% of x402 agent-to-agent volume** (wk of 2026-02-09). Base hosts the most active
  deployment; Solana is roughly half. **Accept both** to reach the market.
- ⚠️ **The 100M+ x402 tx on Base are inflated by meme-coin activity (PING).** Real
  API-consumption volume is smaller — don't size the business off the headline number.
- ✅ **Circle CCTP is LIVE on Stellar (since May 2026)** — native USDC, no wrapped, no third-party
  bridge — connecting Stellar ↔ Base ↔ Solana ↔ 20+ chains. This is the linchpin and it exists.
  Docs: https://developers.stellar.org/docs/tokens/cross-chain-transfers ·
  https://developers.circle.com/cctp/concepts/supported-chains-and-domains
- ⚠️ **Verify CCTP V1 vs V2 / latency** on the Base→Stellar and Solana→Stellar routes (V1 ≈ 13–19 min;
  V2 "fast" ≈ seconds–minutes).
- **No peso-stablecoin bridge yet** (MXNe/MXNB not bridgeable today). Move **USDC** via CCTP, convert
  **USD→peso at the Stellar edge** (DEX path payment to MXNe, or at cash-out). Small, momentary FX window.
- **Base USDC (verify on basescan):** Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, chain id
  **84532**, **6 decimals**. **Solana devnet USDC:** verify on Circle docs. Use testnets for the demo.
- **Canonical x402 schemes:** Base/EVM uses **EIP-3009** (`transferWithAuthorization`, gasless, in the
  `X-PAYMENT` header). Solana x402 uses an SPL-transfer scheme (different mechanism). Implement the
  real schemes — read https://x402.org (versioned) before coding.

### What already exists in this repo (verified against code)
| Asset | Where | Role in the product |
|---|---|---|
| x402 middleware | `apps/api/src/middleware/x402.ts` (`verifyPayment` L107, `mock:` L110, 402 challenge L55–73) | 🟦 **Cobrador** — extend to Base + Solana |
| Replay protection | `apps/api/src/db/x402.ts` | reuse for Base/Solana payment refs |
| ZKaaS | `apps/api/src/routes/zk.ts` + `contracts/zk-verifier/` (deployed Soroban `CBOWU3OVOPGN3ME2R7EFK2Z2JZY4XYRB6A3HBTQ2Q2WWPSXK3VREUQC7`) | 🟩 **Portero** + **the Stellar showcase** |
| Service catalog / skill | `apps/api/src/routes/services.ts`, `skill/SKILL.md` | discovery — advertise Base+Solana |
| Cash-out | `apps/api/src/routes/cash.ts` (MicopayEscrow on Soroban) | 🟥 **Puerta a pesos — PHASE 2** (the moat) |
| AtomicSwapHTLC | `contracts/atomic-swap/` (deployed, sha256) | ⚙️ reserved for treasury/multi-asset, NOT the USDC hot path |
| Bazaar | `apps/api/src/routes/bazaar.ts` | 🗄️ **PARKED** — returns when liquidity comes from the agent network |

### The pieces map
```
🟦 COBRADOR (x402)      🟩 PORTERO (ZKaaS on Soroban)   🟥 PUERTA A PESOS   ← LA CARA
  pay per call            anonymous trust, ON STELLAR      (Phase 2, the moat)
  Base + Solana
        └──────────────────────┴────────── agent only sees this ─────────
                               │
⚙️ MOTOR (hidden, capital-light): accept USDC on Base/Solana → CCTP → USDC on Stellar
   → Soroban (ZK verify) / DEX USDC→MXNe → merchant network → cash [Phase 2]
   (AtomicSwapHTLC reserved for treasury rebalancing / multi-asset only)

🗄️ REPISA: Bazaar as a headline product — parked
```

### Workflow rules
- Branch off `main` (not protected). One branch + PR per WP: `feat/p1-wp1-evm-client`, etc.
- Each WP ends with its **Verify** gate. Report pass/fail honestly. Existing Stellar flows must not break.
- Commit messages end with `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`.
- Money code: testnet only, never log secrets/keys, never auto-broadcast in a script without a flag.
- **NOTE:** ZKaaS hardening work may be uncommitted — check `git status`; WP-Group C depends on ZK reputation.

---

## 1. Scope

**PHASE 1 (build now):** Agents on **Base and Solana** discover MicoPay, pay our services via canonical
x402, gated by **ZK reputation (Soroban)**, with the **CCTP settlement spine** proven into Stellar.
**Demo headline (Stellar-centric):** *"an agent on Base/Solana pays x402 to verify a ZK reputation proof
on Stellar/Soroban — anonymous trust, settled on-chain on Stellar, reachable from the agent economy."*

**PHASE 2 (deferred — do NOT build):** physical pesos cash-out, merchant network, KYC/AML, MXN
inventory. The moat. Funded by Phase 1; reuses the same CCTP + Soroban rails — no rework.

**PARKED:** Bazaar as a product. Its components (HTLC, ZK, x402) live on inside the product.

---

## GROUP A — Accept payment from Base + Solana (🟦 Cobrador)

### WP1 — Multi-chain client + CCTP config  ·  ~1.5 h · low risk
**Files:** `apps/api/package.json`, `apps/api/src/config.ts`, `apps/api/.env.example`.
1. `cd apps/api && npm i viem @solana/web3.js @solana/spl-token`.
2. `.env.example`:
   ```env
   # ── x402 acceptance ──────────────────────────────────
   X402_ACCEPT_CHAINS=base,solana,stellar
   # Base / EVM
   BASE_RPC_URL=https://sepolia.base.org
   BASE_CHAIN_ID=84532
   BASE_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
   PLATFORM_BASE_ADDRESS=        # 0x... where Base x402 payments land
   X402_FACILITATOR_URL=         # optional Coinbase x402 facilitator (else self-submit)
   RELAYER_EVM_PRIVATE_KEY=      # testnet only — submits EIP-3009 auths / CCTP burns
   # Solana
   SOLANA_RPC_URL=https://api.devnet.solana.com
   SOLANA_USDC_MINT=             # verify devnet USDC mint on Circle docs
   PLATFORM_SOLANA_ADDRESS=      # where Solana x402 payments land
   # CCTP (Base/Solana → Stellar)
   CCTP_BASE_TOKEN_MESSENGER=    # verify on Circle docs
   CCTP_SOLANA_DOMAIN=           # verify on Circle docs
   CCTP_STELLAR_DOMAIN=          # verify on Circle docs
   ```
3. Read these in `config.ts` (mirror the Stellar vars).
**Verify:** `npx tsc --noEmit` clean; both `viem` and `@solana/web3.js` import.

### WP2 — Multi-scheme x402 challenge  ·  ~2–3 h · low risk
**File:** `apps/api/src/middleware/x402.ts` (402 block L55–73).
Emit an `accepts: []` array advertising **stellar-usdc** + canonical x402 **`exact` on base-sepolia**
(EIP-3009) + **Solana** scheme. Gate each on `X402_ACCEPT_CHAINS`. Keep legacy top-level fields
(additive, non-breaking). Match field names to the current x402 spec (x402.org).
**Verify:** `curl -i` a paid endpoint → 402 whose `accepts` lists base, solana, and stellar; existing tests pass.

### WP3 — Base payment verifier (EIP-3009)  ·  ~4–6 h · medium risk · CORE
**Files:** `apps/api/src/middleware/x402.ts` (`verifyPayment` L107) + new `apps/api/src/services/base-payment.service.ts`.
1. Branch on `X-PAYMENT`: `mock:` (keep) → Stellar XDR (keep) → base64 x402 JSON → `verifyBaseX402(...)`.
2. Decode the EIP-3009 authorization; verify signature recovers payer, `to`==`PLATFORM_BASE_ADDRESS`,
   token==`BASE_USDC_ADDRESS`, `value`≥required (**6-dp scaling**), `validBefore` not expired,
   chain id==`BASE_CHAIN_ID`, nonce unused (replay via `db/x402.ts`).
3. Settle: POST to `X402_FACILITATOR_URL` OR self-submit `transferWithAuthorization` via viem; confirm.
4. Attach payer `0x...` as `payerAddress`; handlers stay chain-agnostic.
**Non-custodial note:** for our OWN services the USDC lands in `PLATFORM_BASE_ADDRESS` (we got paid).
**Verify:** integration test (viem mocked, mirror `__tests__/zk.test.ts`): valid auth → 200; replayed nonce → 402; underpayment → 402; expired auth → 402.

### WP3b — Solana payment verifier  ·  ~4–6 h · medium risk · reaches ~half the market
**File:** new `apps/api/src/services/solana-payment.service.ts`; wire into `verifyPayment`.
Implement the Solana x402 scheme (SPL USDC transfer to `PLATFORM_SOLANA_ADDRESS`): verify the
transaction/signature via `@solana/web3.js`, confirm mint==`SOLANA_USDC_MINT`, amount ≥ required
(6-dp), destination correct, signature unused (replay). Attach the Solana payer pubkey as `payerAddress`.
**Honest note:** Solana's x402 mechanism differs from EIP-3009 — this is genuinely separate work, not a
copy of WP3. Sequence it after WP3 but do not skip it — Solana is ~half the agent volume.
**Verify:** integration test (mocked RPC): valid transfer → 200; replay → 402; underpayment → 402.

### WP4 — Catalog + SKILL.md advertise Base + Solana  ·  ~1 h · low risk
**Files:** `apps/api/src/routes/services.ts`, `skill/SKILL.md`.
Add `payment_networks: ["stellar","base","solana"]`; document the per-chain payment shapes + testnet
USDC addresses. Bump `version`. Frame MicoPay's services as "verified trust + path to real money on Stellar".
**Verify:** `curl /api/v1/services | grep -E 'base|solana'`; `curl /skill.md | grep -iE 'base|solana'`.

**🏁 Milestone (Group A):** an agent on Base OR Solana pays a MicoPay endpoint in USDC via canonical x402, in one request.

---

## GROUP B — CCTP settlement spine into Stellar (⚙️ engine)

### WP5 — CCTP → Stellar transfer service  ·  ~1–1.5 days · medium risk
**New:** `apps/api/src/services/cctp.service.ts`.
Implement native USDC transfer **Base→Stellar and Solana→Stellar**: `depositForBurn` on the source
chain, fetch Circle attestation, mint on Stellar. Verify CCTP contracts/domains + V1/V2 + latency.
**Important — do NOT CCTP every micropayment.** A $0.001 fee must not trigger a bridge tx. CCTP is for
**treasury rebalancing** (move accumulated Base/Solana USDC to Stellar in batches) and **larger value
transfers** (the future cash-out amount). Micro-fees accumulate on the source chain as revenue.
**Verify:** a scripted Base→Stellar AND Solana→Stellar USDC transfer settles on testnet; print Stellar tx + amount.

### WP6 — Stellar edge conversion USDC→MXNe (optional in P1)  ·  ~2–3 h · low–medium
**File:** extend `apps/api/src/services/stellar.service.ts`.
Convert USDC→MXNe on the Stellar DEX via `pathPaymentStrictReceive` (codebase already does this for CETES).
Needed before Phase 2 cash-out; in Phase 1 it proves the peso edge.
**Verify:** a USDC→MXNe path payment executes on Stellar testnet (or documents lack of testnet MXNe liquidity).

---

## GROUP C — Trust gate (🟩 Portero — the Stellar/Soroban showcase)

### WP7 — ZK anonymous credential verification (Soroban) as the access gate  ·  ~3–4 h · medium risk
**Files:** `apps/api/src/routes/zk.ts` (exists), and the services that should be gated.
1. Keep **discovery free** (`/services`, `/skill.md`, `/zk/circuits`).
2. For chosen paid endpoints, allow a `reputation_v1` proof (via the deployed ZKaaS verify path on
   **Soroban**) as the gate — *prove a valid anonymous credential without revealing identity or linking
   activity*. Free to read, credential-gated to act. The gate uses the anonymous Merkle-membership +
   nullifier engine (same deployed circuit); reputation is the leaf type used in Phase 1.
**Verify:** call a gated endpoint without a valid proof → rejected; with a valid proof → allowed (verified on Soroban).

---

## GROUP D — Distribution & proof (MicoPay as customer #1, listed where the agents are)

### WP8 — x402 descriptor + example agent (the demo)  ·  ~3–4 h · low risk
1. `skill/agentkit.json` (or `/.well-known/x402` + OpenAPI) in the format AgentKit / x402 clients consume (verify schema on x402.org).
2. `examples/agent/` — a tiny agent (`viem` for Base and/or `@solana/web3.js` for Solana) that discovers
   MicoPay, pays USDC via canonical x402, and consumes the **Stellar/Soroban ZKaaS verify** end-to-end.
   This IS the headline demo: *an agent from the x402 economy used a Stellar service, no Stellar account.*
3. Root `README.md`: a "For Base/Solana agents" section; Stellar as the value hub; pesos as Phase 2.
**Verify:** `examples/agent` runs end-to-end against the local API + testnets.

### WP9 — List MicoPay on agentic.market  ·  ~2–3 h · low risk · instant distribution
**Goal:** register MicoPay's x402 services (start with **ZKaaS verify**, then cash-out in Phase 2) in the
agentic.market directory, where the demand already is. Confirm their listing/discovery format and submit.
This makes MicoPay discoverable to agents on Base + Solana **today**, and is the cheapest distribution we have.
**Verify:** MicoPay's ZKaaS service appears in agentic.market discovery and is callable end-to-end with x402.

---

## Execution order
1. **Batch A (demo unlock):** WP1 → WP2 → WP3 → WP3b → WP4.  *Base + Solana agents can pay & find us.*
2. **Batch C + D (the Stellar showcase + proof):** WP7 → WP8 → WP9.  *An agent from x402 consumes ZKaaS on Soroban, and we're listed where they live.*
3. **Batch B (settlement spine):** WP5 → WP6.  *Value provably moves Base/Solana→Stellar→peso edge.*

**Demo-critical path = Batch A (WP3 minimum) + WP7 + WP8.** That tells the Stellar-hackathon story: an
agent pays from the x402 economy and consumes verified trust on Soroban. WP3b (Solana) widens reach;
WP5/WP6 prove the engine for Phase 2; WP9 is distribution.

## Definition of done (Phase 1)
- [ ] An agent pays canonical x402 USDC on **Base** (WP3) — and on **Solana** (WP3b) — to unlock a MicoPay endpoint.
- [ ] `examples/agent` consumes **ZKaaS verify on Soroban** from the x402 economy, end-to-end, no Stellar account.
- [ ] ZK reputation (Soroban) gates a paid endpoint (free to read, gated to act).
- [ ] CCTP Base→Stellar AND Solana→Stellar USDC transfer demonstrated on testnet.
- [ ] MicoPay listed on agentic.market (ZKaaS service discoverable + callable).
- [ ] No MicoPay custody of third-party funds; micro-fees do not trigger per-call bridges.
- [ ] `apps/api` `npx tsc --noEmit` + `npm test` green; Stellar flows unaffected; no secrets logged.
- [ ] README/SKILL.md frame Stellar as the value hub; Base+Solana as acquisition; pesos = Phase 2; Bazaar parked.

## Risks & honest caveats
| Risk | Mitigation |
|---|---|
| **Positioning: "Stellar = non-EVM rail" is wrong** | Solana owns non-EVM agents (~49%). Position Stellar as ZK-trust + real-money hub, not "another chain" |
| Solana x402 ≠ EIP-3009 | WP3b is real separate work; don't copy WP3. Reaching only Base misses ~half the market |
| x402 spec field drift | Read x402.org before WP2/WP3/WP3b/WP8; keep Stellar fields additive |
| CCTP latency (~minutes on V1) | Verify V2/fast; for fees, accumulate (don't bridge per-call) |
| USDC 6 decimals (Base + Solana) | Explicit scaling in WP3/WP3b; boundary unit tests |
| FX window (USD→peso at edge) | Convert at the Stellar edge right before use; momentary, small |
| Drifting into custody | WP3/WP3b only receive payment for OUR services; third-party cash = Phase 2 |
| Market size inflated by meme coins | Real API-consumption volume < 100M headline; target genuine demand (inference) |
| Platform dependency (Coinbase/Solana) | Stellar core; Base/Solana are channels, not the home |

## Open decisions
1. **Which paid endpoints get ZK-gated** vs. left open (WP7).
2. **CCTP V1 vs V2** on Base→Stellar and Solana→Stellar (latency → UX promise).
3. **Self-submit EIP-3009 vs Coinbase facilitator** (WP3); equivalent choice for Solana settlement (WP3b).
4. **Solana priority** — ship Base first (WP3) for the demo, then WP3b before launch? Or both for the demo since Solana is ~half the market?

---

## What changed in this adjustment (2026-06-16)
- **Hackathon framing added up top** — Stellar is the value/trust hub; Base+Solana are venues. This is the judge story.
- **Added Solana** as a payment-acceptance source (WP1 config, WP2 challenge, WP3b verifier, WP4 catalog, WP5 CCTP) — it's ~49% of x402 volume, not optional.
- **Repositioned Stellar** — removed the "non-EVM rail" claim (Solana owns that); Stellar = ZK trust on Soroban + real-money/LatAm cash. ZKaaS is the hackathon showcase, not just a feature.
- **Added WP9** — list MicoPay on agentic.market for instant distribution where the agents are.
- **Corrected the market facts** — Base+Solana (not Stellar) settle x402; 100M tx inflated by meme coins; inference is confirmed top demand.

**Last updated:** 2026-06-16 · **Frame:** Stellar as the value hub for the agentic economy; accept from
Base+Solana via CCTP; ZK trust on Soroban is the showcase; pesos = Phase 2 moat; Bazaar parked.
