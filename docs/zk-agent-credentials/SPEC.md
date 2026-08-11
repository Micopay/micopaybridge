# ZK-as-a-Service (ZKaaS) on Micopay
**Private resource-access verification for AI agents — pay-per-use, zero-knowledge, on Stellar (Soroban).**

> **Pitch in one line:** ZKaaS is a Soroban-powered verification service where an AI agent proves it holds a valid, unspent access credential — **without revealing who it is or letting anyone link its activity**. Verified on-chain on Stellar, paid via x402. Reputation is one application of the same engine.

## Table of Contents
1. [Overview](#overview)
2. [Problem Statement](#problem-statement)
3. [Solution Overview](#solution-overview)
4. [Hackathon Scope: Core vs Stretch](#hackathon-scope-core-vs-stretch)
5. [System Architecture](#system-architecture)
6. [Technical Details](#technical-details)
7. [Demo Walk-through](#demo-walk-through)
8. [Why This Fills a Gap in the Stellar Ecosystem](#why-this-fills-a-gap-in-the-stellar-ecosystem)
9. [Roadmap: The Bigger Ecosystem](#roadmap-the-bigger-ecosystem)
10. [Deployment Instructions](#deployment-instructions)
11. [Testing & Validation](#testing--validation)
12. [References & Useful Links](#references--useful-links)
13. [License](#license)

## Overview

Micopay already provides real-world P2P crypto-to-cash rails on Stellar: users lock USDC in a Soroban HTLC (MicopayEscrow), meet a cash agent, show a QR code, receive pesos, and the agent receives the USDC after the QR is scanned. Every completed exchange generates **reputation** — currently exposed as public soulbound badges and an x402 API endpoint.

The ZK-as-a-Service (ZKaaS) extension adds a generic, pay-per-use zero-knowledge proof verification endpoint (`/api/v1/zk/verify`) to Micopay's existing x402-protected API, backed by a **multi-circuit verifier contract** on Soroban. Any agent (or the Micopay mobile app itself) can:

- Submit a ZK proof (generated off-chain with Noir/UltraHonk)
- Pay a tiny USDC fee via the x402 protocol
- Receive a boolean (`true`/`false`) indicating whether the proof is valid

ZKaaS ships with **two registered circuits**:

| Circuit | What it proves | Role |
|---------|----------------|------|
| `poseidon_preimage` | "I know the secret behind this hash" — without revealing it | Building block for HTLC coordination and cross-chain swaps |
| `reputation_v1` 🏆 | "I hold a valid leaf in this set with tier ≥ T" — without revealing which leaf, who I am, or linking my uses | **The deployed anonymous-membership engine** (Merkle membership + nullifier + tier check). The anonymous *access credential* is the same engine with the leaf meaning "paid access" and no tier check — the immediate build, not yet a separately registered circuit. |

Because verification runs inside a single Soroban contract calling the BN254 host functions (`g1_msm`, `pairing_check`, `keccak256` — Protocol 25/26), the cost per verification is negligible — the caller only pays the x402 micropayment (e.g., 0.001 USDC).

**The product story:** an AI agent consumes a resource (inference, data, APIs) by proving it holds a valid access credential — without revealing who it is, which credential it holds, or linking its activity across sessions. Reputation is one instance: the same Merkle-membership engine can prove "my tier is ≥ SILVER" using a reputation leaf instead of an access leaf. **Access credentials are the flagship; reputation is an application.**

## Problem Statement

| Issue | Why it matters for Micopay / Stellar Hacks |
|-------|------|
| **Reputation exposure** | The `/reputation/:address` endpoint returns exact scores and links them to an address. A cash agent's full business history is readable by competitors; a user's financial life is public. Reputation that is public is surveillance; reputation that is private is useless — unless ZK breaks the dilemma. |
| **Linkability in HTLC** | The current HTLC requires revealing the pre-image to unlock funds, allowing observers to link transactions. A ZK proof-of-knowledge enables commitments without early disclosure. |
| **No attestation standard on Stellar** | Stellar's native primitives (authorized trustlines, SEP-12 KYC) are binary or off-chain. There is no Soroban-native, privacy-preserving way for a third party to verify a claim about a user. |
| **High barrier to ZK adoption** | Developers must deploy and maintain their own verifier contracts and understand low-level cryptography. |
| **Agents can't buy trust** | AI agents coordinating transactions (Micopay's Bazaar) have no way to verify a counterparty's trustworthiness without doxxing them — and no way to pay for that verification autonomously. |

The hackathon's theme — **Real-World ZK on Stellar** — demands a production-like use case. Ours: *an AI agent consumes a resource (e.g., paid inference) by proving it holds a valid, unspent access credential — anonymous and unlinkable — verified on Soroban.* The deployed circuit `reputation_v1` demonstrates the same engine with a reputation leaf: prove tier ≥ T without revealing identity.

## Solution Overview

We expose a generic ZK verification endpoint that:

1. Accepts a JSON payload containing:
   - `circuit_id` – which registered circuit the proof targets (`poseidon_preimage` | `reputation_v1`)
   - `proof` – the binary proof (base64-encoded) generated off-chain with Noir/UltraHonk
   - `public_inputs` – array of public field elements (as decimal strings)

2. Charges a tiny USDC amount via the existing x402 micropayment mechanism

3. Executes the on-chain verifier inside a Soroban contract with a **verification-key registry**: each `circuit_id` maps to an admin-registered VK. The contract dispatches to the UltraHonk/BN254 host verification routine with the right VK.

4. Returns `{ verified: true | false }`

### The anonymous access credential model (flagship)

The core primitive is **Merkle membership + nullifier** — think arcade tokens:

```
Buy:     secret s  →  commitment C = H(s)  →  C added as a leaf in a Merkle tree
         → only the 32-byte ROOT is published on Soroban

Consume: ZK proof  "I know the secret behind ONE leaf in the tree"
         + reveal nullifier H(s, context)
         → WITHOUT revealing which leaf, the secret, or who you are

Reuse:   same nullifier → rejected on-chain (double-spend prevented)

Privacy: you are hidden among EVERY credential in the tree (the anonymity set).
         More credentials in the tree = stronger privacy.
```

Even MicoPay cannot link a spend back to a purchase: you cannot go from `H(s)` to the leaf `C` without knowing `s`.

**What ZK does and doesn't hide:**

| Hidden ✅ | Not hidden ❌ |
|---|---|
| **Who you are** (identity, address) | The **content** of your request (the prompt/payload) |
| **Linkability** across uses and back to your purchase | |
| **Your balance / which credential** you hold | |

> Hiding request *content* requires FHE/TEE — **roadmap, not claimed here**. ZK hides *who* is asking, not *what* they are asking.

**Reputation is one application** of this engine: a reputation leaf encodes `H(secret, tier)`. Access credentials encode `H(secret, "paid")`. Same cryptographic primitives, different leaf semantics.

### Why a VK registry (and not one contract per circuit)

UltraHonk verification is bound to a specific circuit via its verification key. A registry keyed by `circuit_id`:

- Makes ZKaaS an actual *service*: new circuits are registered, not redeployed
- Is the security boundary: the API **never** accepts a caller-supplied VK (an attacker could submit a VK for a trivially satisfiable circuit and forge `verified: true`). Only the admin registers audited VKs.
- Is honest about the moat: a sophisticated caller could invoke the contract directly. The value of the API is **curation** (audited VKs), ergonomics (HTTP/JSON, no Stellar account needed), and the x402 audit trail — not exclusivity.

### The reputation pipeline (one application of the access credential engine)

All of it is Stellar-native:

```
1. EARN     Completed P2P exchanges in Micopay (Soroban HTLC escrows)
            feed the Reputation Engine (off-chain DB scoring)
                          │
2. ANCHOR   The engine builds a Merkle tree of H(user_secret, tier)
            and publishes ONLY the 32-byte root to a Soroban contract
                          │
3. PROVE    The user's app generates a Noir proof:
            "I know a leaf in the tree with root R whose tier ≥ T"
            — revealing nothing else
                          │
4. CONSUME  Merchants and AI agents verify via ZKaaS ($0.001 x402)
            without ever learning who the user is
```

This matches Stellar's design philosophy — sensitive data off-chain, enforcement on-chain — but replaces "trust the anchor" with "verify the math".

## Hackathon Scope: Core vs Stretch

The submission is structured so a last-day failure in the stretch goal cannot sink the core.

### CORE (the minimum viable submission — 100% Stellar)

1. **ZKaaS service**: `/api/v1/zk/verify` + x402 + Soroban verifier contract with VK registry
2. **Circuit 1** (`poseidon_preimage`): proves knowledge of a Pedersen hash pre-image (BN254 Pedersen — `poseidon_preimage` is the registry name; see §6.1 for the hash note)
3. **Circuit 2** (`reputation_v1`): the anonymous-membership engine — Merkle membership + tier threshold + nullifier (the access-credential circuit is the same engine without the tier check)
4. **Agent demo (Stellar-only)**: an agent consumes a resource by proving it holds a valid, unspent credential — anonymous, unlinkable, double-spend-proof (reuse → nullifier rejected on-chain). Demonstrated today with `reputation_v1` as the engine (leaf = reputation tier); the credential walk-through is in [`HACKATHON.md`](./HACKATHON.md).

### STRETCH (cross-chain leg — only if time allows)

5. **XRPL escrow leg of an atomic swap**: XRPL's native escrow uses PREIMAGE-SHA-256 crypto-conditions — the *same* HTLC primitive as MicopayEscrow. The same 32-byte secret unlocks both chains. B locks XRP in a native XRPL escrow with the same condition hash; A claims it by revealing the secret (`EscrowFinish`); B uses the revealed secret to claim the USDC on Stellar. No smart contract needed on XRPL.
6. Demo extension: the agent-coordinated swap completes across both chains, and the successful swap feeds back into the reputation tree (the loop closes).

**Judge framing:** Stellar is where the intelligence lives — ZK verification, agent coordination, and x402 payments all happen on Soroban. Other chains are venues agents reach into. The stretch goal demonstrates Stellar as a multi-chain coordination hub, not a bridge project.

## System Architecture

```
+-------------------+        x402 (USDC)        +----------------------+
|   AI Agent / App  |  --------------------->   |  Micopay API         |
| (Noir prover:     |  <--------------------    |  (Fastify)           |
|  noir_js / bb.js) |   POST /zk/verify         +----------+-----------+
+-------------------+   { circuit_id, proof,               |
                          public_inputs }                  |
                                                           v
                                            +------------------------------+
                                            |  Soroban: ZkVerifierRegistry |
                                            |  Map<circuit_id, VK>         |
                                            |  verify(circuit_id, proof,   |
                                            |         public_inputs)       |
                                            +--------------+---------------+
                                                           |
                                                           v
                                            +------------------------------+
                                            |  ultrahonk_soroban_verifier  |
                                            |  (crate compiled into the    |
                                            |   contract WASM) calling     |
                                            |   host functions:            |
                                            |   crypto().bn254().g1_msm()  |
                                            |   .pairing_check()           |
                                            |   crypto().keccak256()       |
                                            +------------------------------+

  REPUTATION DATA FLOW (Stellar-native):

  Micopay P2P escrows ──► Reputation Engine ──► Merkle root ──► Soroban
   (completed swaps)        (off-chain DB)      (32 bytes)      contract
                                                                   ▲
                                            user proves membership │
                                            + tier ≥ T via ZKaaS ──┘
```

**Components:**
- **Agent/App** – generates ZK proofs off-chain (Noir; in-browser/mobile via `noir_js` + `bb.js` WASM)
- **Micopay API** – enforces x402, forwards to the Soroban contract, returns the result
- **ZkVerifierRegistry (Soroban)** – VK registry + dispatch to the verifier crate; also stores the current reputation Merkle root (updated by the Reputation Engine's admin key)
- **Reputation Engine** – off-chain service that scores users from Micopay activity and publishes Merkle roots
- **Verifier internals** – there is **no single `verify_ultrahonk` host function**. The `ultrahonk_soroban_verifier` crate is compiled into the contract WASM and performs verification using the BN254 host functions (`env.crypto().bn254().g1_msm()`, `.pairing_check()`) plus `keccak256`. The hashing inside the circuits runs off-chain (inside the WASM prover) — the chain only verifies the UltraHonk proof, not the circuit's hash function.

## Technical Details

### 6.1. Circuit 1: Pedersen pre-image / `poseidon_preimage` (Noir)

Proves knowledge of a pre-image of a Pedersen hash. Used to validate the rail and, in the agent demo, as the *commitment step* of an HTLC: the buyer proves they know the swap secret **before** the counterparty locks funds — removing the trust gap in HTLC setup.

> **Hash note:** Despite the circuit registry name `poseidon_preimage`, the circuit uses **BN254 Pedersen** (`std::hash::pedersen_hash`) because `poseidon::bn254` is not exported in nargo 1.0.0-beta.9 (our pinned version). The registry name is fixed on-chain; the implementation is correct. Both are BN254-native and circuit-cheap — the UltraHonk verifier is hash-agnostic.

**File: `circuits/poseidon_preimage/src/main.nr`**

```noir
// `secret` is private (default); `hash` is the public input.
fn main(secret: Field, hash: pub Field) {
    let h = std::hash::pedersen_hash([secret]);
    assert(h == hash);
}
```

### 6.2. Circuit 2: Anonymous credential engine / `reputation_v1` (Noir)

This is the **access credential engine**: Merkle membership + threshold check + nullifier. With a reputation leaf (`H(secret, tier)`) it proves *"I know a leaf in the official Merkle tree (root R) whose tier is ≥ T"*. With an access leaf (`H(secret, "paid")`) it proves *"I hold a valid, unspent access credential"*. The circuit is identical — the leaf semantics differ. The deployed instance (`reputation_v1`) uses the reputation variant; `access_credential_v1` is the same circuit with access semantics, the immediate next build on a proven engine.

> **Hash note:** The circuit uses **BN254 Pedersen** (`std::hash::pedersen_hash`) instead of Poseidon because `poseidon::bn254` is not exported in nargo 1.0.0-beta.9 (our pinned version). The VKs on-chain match this implementation. The Merkle root published on Soroban was built with the same Pedersen hash.

**File: `circuits/reputation_v1/src/main.nr`**

```noir
global TREE_DEPTH: u32 = 20;   // 2^20 ≈ 1M users

fn main(
    // ---- private inputs ----
    secret: Field,                       // user's reputation secret
    tier: Field,                         // 1=BRONZE 2=SILVER 3=GOLD 4=PLATINUM
    path_elements: [Field; TREE_DEPTH],  // Merkle siblings
    path_index: [u1; TREE_DEPTH],        // 0 = node is left child, 1 = right
    // ---- public inputs ----
    pub merkle_root: Field,              // published on Soroban by the engine
    pub tier_threshold: Field,           // e.g. 2 (SILVER)
    pub context: Field,                  // H(verifier_id, session) — binds the proof
    pub nullifier: Field,                // H(secret, context) — prevents replay
) {
    // 1. Leaf commitment (BN254 Pedersen)
    let leaf = std::hash::pedersen_hash([secret, tier]);

    // 2. Merkle inclusion proof
    let mut node = leaf;
    for i in 0..TREE_DEPTH {
        let sibling = path_elements[i];
        let (l, r) = if path_index[i] == 0 { (node, sibling) } else { (sibling, node) };
        node = std::hash::pedersen_hash([l, r]);
    }
    assert(node == merkle_root);

    // 3. Tier threshold (tiers are tiny ints — safe to compare as u64;
    //    Fields have no native ordering in Noir)
    assert(tier as u64 >= tier_threshold as u64);

    // 4. Nullifier: unique per (secret, context). The verifier supplies
    //    `context`; a proof generated for one verifier/session cannot be
    //    replayed at another.
    let n = std::hash::pedersen_hash([secret, context]);
    assert(n == nullifier);
}
```

**Anti-replay design (important for judges' Q&A):** a valid proof is just a blob — without binding, anyone who intercepts it could replay it and impersonate "SILVER". The `context` public input (hash of verifier identity + session nonce, chosen by the verifier at challenge time) makes each proof single-purpose. The `nullifier` additionally lets a verifier detect the same anonymous user proving twice in one context (rate-limiting without identity).

### 6.3. Proof Generation — toolchain note (READ FIRST)

> ⚠️ **The Noir toolchain split proving out of `nargo`.** In older Noir (≤ ~0.19) `nargo prove` existed; in current releases the flow is `nargo execute` (witness) + **Barretenberg** `bb prove` (proof) and `bb write_vk` (verification key).
>
> **Pinned versions (validated against `rs-soroban-ultrahonk`, the only known project with UltraHonk running on Soroban — do not upgrade without re-validating):**
>
> | Tool | Version |
> |------|---------|
> | nargo | 1.0.0-beta.9 |
> | bb (Barretenberg) | 0.87.0 |
> | soroban-sdk | 26.0.1 |
> | stellar-cli | 25.2.0 |
>
> **Windows note:** `noirup` ships Linux/macOS binaries only — circuit work (Phases with nargo/bb) runs under **WSL2** (Ubuntu). Rust contract + TypeScript API work fine natively.

```bash
# 1️⃣ Install Noir + Barretenberg (pin versions!)
curl -L https://noir-lang.org/install.sh | bash    # noirup
noirup -v <PINNED_VERSION>
# bb install per https://github.com/AztecProtocol/barretenberg

# 2️⃣ Compile the circuit
cd circuits/reputation_v1
nargo compile                        # target/reputation_v1.json

# 3️⃣ Fill Prover.toml with inputs (witness data)
#    (the Reputation Engine CLI exports the user's merkle path + inputs)

# 4️⃣ Generate witness, then proof
nargo execute witness                # target/witness.gz
bb prove -b target/reputation_v1.json -w target/witness.gz -o target/proof

# 5️⃣ Extract the verification key (registered once on-chain by the admin)
bb write_vk -b target/reputation_v1.json -o target/vk
```

**Mobile/browser proving:** `noir_js` + `bb.js` (WASM) can generate these proofs client-side. A depth-20 Merkle circuit takes seconds on a phone — acceptable, but benchmark early; fallback is server-side proving (acceptable privacy trade-off for the demo).

### 6.4. On-chain Verifier with VK Registry (Soroban)

A standalone `ZkVerifierRegistry` contract (cleaner than upgrading MicopayEscrow — Soroban WASM is immutable, and verification is a separate concern):

```rust
// contracts/zk-verifier/src/lib.rs (sketch)
use soroban_sdk::{contract, contractimpl, Address, Bytes, Env, Symbol, Vec, U256};

#[contract]
pub struct ZkVerifierRegistry;

#[contractimpl]
impl ZkVerifierRegistry {
    pub fn init(env: Env, admin: Address) {
        env.storage().instance().set(&Symbol::new(&env, "admin"), &admin);
    }

    /// Admin-only: register an audited verification key for a circuit.
    /// The API must NEVER accept caller-supplied VKs — this registry is
    /// the security boundary against trivially-satisfiable forged circuits.
    pub fn register_circuit(env: Env, circuit_id: Symbol, vk: Bytes) {
        let admin: Address = env.storage().instance()
            .get(&Symbol::new(&env, "admin")).unwrap();
        admin.require_auth();
        env.storage().persistent().set(&circuit_id, &vk);
    }

    /// Admin-only: publish the current reputation Merkle root.
    pub fn set_reputation_root(env: Env, root: U256) {
        let admin: Address = env.storage().instance()
            .get(&Symbol::new(&env, "admin")).unwrap();
        admin.require_auth();
        env.storage().persistent().set(&Symbol::new(&env, "rep_root"), &root);
    }

    pub fn get_reputation_root(env: Env) -> U256 {
        env.storage().persistent()
            .get(&Symbol::new(&env, "rep_root")).unwrap()
    }

    /// Verify a proof against the registered VK for `circuit_id`.
    /// NOTE: there is no UltraHonk host function. Verification is performed
    /// by the `ultrahonk_soroban_verifier` crate (compiled into this WASM),
    /// which internally uses the BN254 host functions:
    ///   env.crypto().bn254().g1_msm(), .pairing_check(), env.crypto().keccak256()
    /// Reference implementation: https://github.com/yugocabrio/rs-soroban-ultrahonk
    pub fn verify(env: Env, circuit_id: Symbol, proof: Bytes,
                  public_inputs: Vec<U256>) -> bool {
        let vk: Bytes = env.storage().persistent().get(&circuit_id)
            .expect("circuit not registered");
        ultrahonk_soroban_verifier::verify(&env, &vk, &proof, &public_inputs)
    }
}
```

For `reputation_v1` calls, the API additionally checks that `public_inputs[merkle_root]` equals `get_reputation_root()` — a stale or fabricated root must be rejected even if the proof verifies against it.

### 6.5. Micopay API Extension (`/api/v1/zk/verify`)

**File: `apps/api/src/routes/zk.ts` (Fastify)** — same transaction-building flow as before (simulate → assemble → sign → submit → poll with bounded retries), now with circuit dispatch:

```typescript
interface ZkVerifyReq {
  circuit_id: 'poseidon_preimage' | 'reputation_v1';
  proof: string;           // base64-encoded UltraHonk proof
  public_inputs: string[]; // BN254 field elements as decimal strings
}

// Per-circuit validation of public input SHAPE before trusting content:
const CIRCUIT_SCHEMAS: Record<string, { numInputs: number }> = {
  poseidon_preimage: { numInputs: 1 },  // [hash]
  reputation_v1:     { numInputs: 4 },  // [root, threshold, context, nullifier]
};

fastify.post<{ Body: ZkVerifyReq }>('/api/v1/zk/verify', async (req, reply) => {
  // x402 middleware ran before this handler (402 already sent if unpaid)
  const { circuit_id, proof, public_inputs } = req.body;

  const schema = CIRCUIT_SCHEMAS[circuit_id];
  if (!schema) return reply.status(400).send({ error: 'Unknown circuit_id' });
  if (!Array.isArray(public_inputs) ||
      public_inputs.length !== schema.numInputs ||
      !public_inputs.every((v) => /^\d+$/.test(v))) {
    return reply.status(400).send({ error: 'Malformed public_inputs for circuit' });
  }

  // reputation_v1: the root MUST match the on-chain published root
  if (circuit_id === 'reputation_v1') {
    const currentRoot = await contractGetReputationRoot();
    if (public_inputs[0] !== currentRoot.toString()) {
      return reply.status(400).send({ error: 'Stale or unknown merkle_root' });
    }
  }

  const verified = await invokeVerify(circuit_id, proof, public_inputs);
  reply.send({ verified });
});
```

The route is protected by Micopay's existing x402 middleware (`apps/api/src/middleware/x402.ts`). `X402_MOCK_MODE=true` accepts a dummy `X-Payment: mock` header for local dev.

> **Production warning:** `X402_MOCK_MODE=true` bypasses all payment validation — never in production. Enforce with a startup assertion: `if (process.env.X402_MOCK_MODE && process.env.NODE_ENV === 'production') throw new Error(...)`.

### 6.6. x402 Micropayment Flow

1. **Client** → `POST /api/v1/zk/verify` (no payment header)
2. **Server** → `402 Payment Required` with `{ amount: "0.001", asset: "USDC", destination, memo, expires_at }`
3. **Client** pays on Stellar, includes signed XDR in `X-Payment` header
4. **Server** verifies payment, invokes the verifier contract
5. **Response** → `{ verified: true | false }`

Every verification is an x402 transaction on Stellar — a transparent usage/fee log.

## Demo Walk-through

### 7.1. Demo A — rail validation (circuit 1, mock x402)

Same end-to-end flow as the original spec: compile the pre-image circuit, generate a proof for `secret = 123456789`, call the endpoint, get `{ verified: true }`; tamper with the witness, get `{ verified: false }`. See §6.3 for the current toolchain commands.

### 7.2. Demo B — the flagship: anonymous credential verification for AI agents

Demonstrates the access credential engine using reputation as the leaf type (same Merkle-membership + nullifier primitives; the leaf meaning is "reputation tier" instead of "paid access").

**Cast:** Agent A (buyer bot) · Agent B (market-maker bot) · the ZKaaS API · Soroban.

```bash
# 0. Setup (pre-demo): Reputation Engine has scored Micopay users and
#    published the Merkle root on Soroban. User behind Agent A is GOLD.

# 1. Agent A asks Agent B for a quote (via Bazaar). B's policy:
#    "I only trade with tier ≥ SILVER counterparties."
#    B responds with a challenge: { context: H(B_id, session_nonce) }

# 2. Agent A's wallet generates the reputation proof locally
#    (noir_js/bb.js — the secret and tier NEVER leave the device):
#    public inputs = [current_root, 2 /*SILVER*/, context, nullifier]

# 3. Agent B verifies, paying 0.001 USDC via x402:
curl -s -X POST "$API/api/v1/zk/verify" \
  -H "Content-Type: application/json" \
  -H "X-Payment: $SIGNED_XDR" \
  -d '{
    "circuit_id": "reputation_v1",
    "proof": "'$PROOF_B64'",
    "public_inputs": ["'$ROOT'", "2", "'$CONTEXT'", "'$NULLIFIER'"]
  }'
# → { "verified": true }

# 4. B now knows: "this anonymous counterparty is ≥ SILVER per the official
#    Micopay reputation tree" — and knows NOTHING else. Trade proceeds:
#    A commits to the HTLC secret via circuit 1, then locks USDC in
#    MicopayEscrow (Soroban HTLC).
```

**What the judges see:** two bots negotiating, a $0.001 payment, a cryptographic verification on Soroban, and a trade unlocked — with zero identity disclosure. Record the full run as a video; keep the live demo as backup (too many moving parts for live-only).

### 7.3. Demo C (STRETCH) — cross-chain atomic swap, ZK-coordinated

If the XRPL leg lands: after step 4 above, B locks XRP in a **native XRPL escrow** whose `Condition` is the same SHA-256 hash A committed to in circuit 1. A claims via `EscrowFinish` (revealing the secret on XRPL); B uses the revealed secret to claim the USDC on Stellar. The completed swap is recorded by the Reputation Engine → next Merkle root → **the reputation both agents will prove tomorrow was earned today. The loop closes.**

## Why This Fills a Gap in the Stellar Ecosystem

Stellar has no native credential primitive (authorized trustlines are binary; SEP-12 KYC is off-chain by design) and Soroban has no dominant attestation standard (no EAS equivalent). ZKaaS fills that gap with **anonymous access credentials**: an agent proves it holds a valid credential without revealing identity, and no one can link its uses. Stellar's philosophy is *sensitive data off-chain, enforcement on-chain* — ZKaaS follows it faithfully, upgrading "trust the anchor" to "verify the math":

```
Stellar philosophy:   sensitive data off-chain  +  enforcement on-chain
ZKaaS:                scores in private DB      +  Merkle root & ZK verification on Soroban
```

Any other Stellar protocol can consume ZKaaS: register a circuit, let users prove claims privately, pay per verification. This is proposed infrastructure for the ecosystem, not a one-off demo.

## Roadmap: The Bigger Ecosystem

ZKaaS is one half of a larger trust infrastructure for LatAm:

| Phase | What | Where |
|-------|------|-------|
| **Now (this hackathon)** | ZKaaS + anonymous access credentials (Merkle membership + nullifier on Soroban); reputation as flagship application | Stellar |
| **+3 months (XRPL hackathon)** | **Avales Líquidos**: a capital pool locks funds in native XRPL escrows to guarantee user obligations (rent, tenders); users pay a fee instead of immobilizing capital. Reputation tiers anchored as XLS-70 Credentials. | XRPL |
| **Convergence** | The Reputation Engine ingests **both** sources (Micopay P2P history + Avales payment history + XLS-70 credentials) into the same Merkle tree. One reputation, earned anywhere, provable privately everywhere — without ever linking a user's Stellar and XRPL addresses publicly (the ZK proof hides the linkage). | Both |
| **Agents everywhere** | Rental platforms, marketplaces and AI agents consume `quote / status / reputation` via x402 — guarantees and trust checks as API calls. | Both |

The Merkle-root design is deliberately chain-agnostic: the tree doesn't know or care where tiers came from. Today: Micopay. Tomorrow: Avales credentials on XRPL. Zero rework.

## Deployment Instructions

### 9.1. Deploy the ZkVerifierRegistry contract

```bash
cd contracts/zk-verifier
cargo build --release --target wasm32-unknown-unknown

stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/zk_verifier.wasm \
  --secret <YOUR_TESTNET_SECRET_KEY> \
  --network testnet
# → note the contract address

# Initialize + register circuits (admin):
stellar contract invoke --id <ADDR> -- init --admin <ADMIN_ADDR>
stellar contract invoke --id <ADDR> -- register_circuit \
  --circuit_id poseidon_preimage --vk <hex of circuits/poseidon_preimage/target/vk>
stellar contract invoke --id <ADDR> -- register_circuit \
  --circuit_id reputation_v1 --vk <hex of circuits/reputation_v1/target/vk>
```

Update `apps/api/.env`:
```env
ZK_VERIFIER_ADDRESS=<address_from_deploy>
```

### 9.2. Run the API with x402 Mock Mode

```bash
cd apps/api
cp .env.example .env
# X402_MOCK_MODE=true
# ZK_VERIFIER_ADDRESS=<address_from_deploy>
npm install
npm run dev   # http://localhost:3000
```

### 9.3. Publish a reputation root (demo data)

```bash
# The Reputation Engine CLI builds a demo tree from seeded users and publishes:
npm run rep:build-tree -- --seed demo_users.json
npm run rep:publish-root
# It also exports each demo user's merkle path for client-side proving.
```

### 9.4. Verify Deployment

1. `GET /api/v1/services` — the ZK Verify entry lists both circuits and prices
2. Run Demo A (§7.1) → `{ verified: true }`
3. Run Demo B (§7.2) with a seeded GOLD user → `{ verified: true }`; with a BRONZE user against threshold SILVER → `{ verified: false }`

## Testing & Validation

| Test Type | Description | How to run |
|-----------|-------------|-----------|
| **Circuit unit tests (Noir)** | Pre-image circuit rejects wrong secret; reputation circuit rejects wrong root, low tier, bad path, wrong nullifier | `nargo test` in each circuit dir |
| **Contract unit tests** | VK registry: admin-only registration; verify dispatches to correct VK; unknown circuit fails; root get/set | `cargo test` with `Env::default()` |
| **API integration** | Schema validation per circuit; stale-root rejection; x402 mock flow | `apps/api/test/zk.test.ts` (supertest) |
| **End-to-end agent demo** | Full Demo B flow scripted | `apps/api/demo/run_zk_demo.sh` |
| **Replay attack test** | A valid proof re-submitted with a different `context` must fail | included in API integration tests |
| **Mobile proving benchmark** | Time to prove reputation_v1 in bb.js (browser + mid-range phone) | `apps/web/bench/prove.html` |
| **Gas / cost measurement** | `fee_charged` of a verification tx via Horizon (expected ≈ 0.00005 XLM) | manual after invoke |

All tests must pass on testnet before submission.

## References & Useful Links

| Resource | URL |
|----------|-----|
| Micopay Protocol Repository | https://github.com/ericmt-98/micopay-protocol |
| Stellar Docs – ZK Proofs on Stellar | https://developers.stellar.org/docs/build/apps/zk |
| Stellar Docs – Privacy on Stellar | https://developers.stellar.org/docs/build/apps/privacy |
| Protocol 25 (X-Ray) Announcement | https://stellar.org/blog/developers/announcing-stellar-x-ray-protocol-25 |
| Protocol 26 (Yardstick) Upgrade Guide | https://stellar.org/blog/foundation-news/stellar-yardstick-protocol-26-upgrade-guide |
| Noir Language | https://noir-lang.org |
| Barretenberg / UltraHonk | https://github.com/AztecProtocol/barretenberg |
| Soroban SDK – BN254 Host Functions | https://docs.rs/soroban-sdk/latest/soroban_sdk/_migrating/v25_bn254/index.html |
| Soroban UltraHonk verifier example | https://github.com/yugocabrio/rs-soroban-ultrahonk |
| Semaphore (membership-proof design reference) | https://semaphore.pse.dev/ |
| XRPL EscrowCreate (crypto-conditions — stretch goal) | https://xrpl.org/docs/references/protocol/transactions/types/escrowcreate |
| x402 Specification | https://x402.org/ |
| Stellar Skills – ZK Proofs | https://skills.stellar.org/skills/zk-proofs/SKILL.md |

## License

This report and the accompanying sample code are released under the MIT License.

---

**Last updated:** 2026-06-17
**Author:** Eric Mota Tejeda
**Project:** Micopay / Stellar Hacks — ZK-as-a-Service + Private Resource Access for AI Agents
