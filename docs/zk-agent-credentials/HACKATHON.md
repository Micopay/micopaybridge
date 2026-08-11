# MicoPay — Private Resource Access for AI Agents

> **ZK Hackathon one-pager. One idea, read in 2 minutes.**
> Everything else (payments, cross-chain, cash) is roadmap — see the bottom.

---

## In one line

> **AI agents consume resources (inference, data, APIs) by proving they hold a valid access
> credential — without revealing who they are, or letting anyone link their activity.
> Verified with zero-knowledge on Stellar (Soroban).**

---

## The problem

The agent economy runs on pay-per-call x402 services (agentic.market lists 1,200+). **Every payment
is public and on-chain** — so anyone, competitors included, can see an agent's full consumption
pattern: which APIs, how much, when. For a business whose agent buys inference, that pattern **leaks
its strategy**.

> The dilemma: usage that is public is surveillance; access you can't prove is access you can't get.

---

## The ZK insight

An agent can prove **"I hold a valid, unspent access credential"** — and *nothing else*. Not its
identity, not its address, not *which* credential, not its remaining balance. **Anonymous, unlinkable,
single-use.**

---

## What we built — ZKaaS on Soroban

A verification service backed by a Soroban contract (`ZkVerifierRegistry`). An agent generates a
Noir/UltraHonk proof off-chain; we verify it **on-chain on Soroban** using Stellar's **BN254 host
functions** (Protocol 25/26). Pay-per-verification via x402.

**The anonymous credential = Merkle membership + nullifier (think arcade tokens):**

```
Buy:      secret s → commitment C = H(s) → C becomes a leaf in a Merkle tree
          → only the 32-byte ROOT is published on Soroban
Consume:  ZK proof: "I know the secret behind ONE leaf in the tree"  + reveal nullifier H(s)
          → WITHOUT revealing which leaf, the secret, or who you are
Reuse:    same nullifier → rejected (double-spend prevented)
Privacy:  you're hidden among EVERY credential in the tree (the anonymity set)
```

The proof reveals only "a valid credential was spent" — never which one, never the holder.
Even MicoPay can't link a spend back to a purchase (you can't go from `H(s)` to `C` without `s`).

---

## The demo (Stellar only)

```
[1] Buy:      agent gets 3 anonymous credentials  → 3 leaves, root on Soroban
[2] Consume:  ZK proof of credential #1  → ✅ resource served (provider learns NOTHING about who)
[3] Reuse:    credential #1 again        → ❌ "nullifier already used" (double-spend caught)
[4] Consume:  credential #2              → ✅ works
```

Outcome: **anonymous + finite + double-spend-proof access**, all verified with ZK on Soroban.

---

## What's real (deployed on Stellar testnet)

- **`ZkVerifierRegistry`** contract: `CBOWU3OVOPGN3ME2R7EFK2Z2JZY4XYRB6A3HBTQ2Q2WWPSXK3VREUQC7`
- **Circuit** `reputation_v1` (Merkle membership + threshold + nullifier), Noir + UltraHonk — the same
  membership-and-nullifier engine the access credential uses.
- **On-chain verification tx:** `330be3e4eae61901526206d33438e38e5b90a65d16871ef1727d5bc075902974`
- **Hash:** BN254 **Pedersen** (not Poseidon — `poseidon::bn254` isn't exported in nargo 1.0.0-beta.9; see TOOLCHAIN.md)

> The verification engine (anonymous Merkle membership + nullifier, verified on Soroban) is **live**.
> The access-credential circuit (`access_credential_v1`) is the same primitives with the leaf meaning
> "paid access credential" instead of "reputation tier" — the immediate build on a proven engine.

---

## Why Stellar

Stellar is betting on **"open by default, private when needed"** — ZK for compliant, private finance.
Soroban added **BN254** so smart contracts verify zk-SNARKs on-chain. Stellar has **no native
credential primitive** — we built it. This is the trust/privacy layer the Stellar agent economy needs.

---

## Honest scope (what ZK does and doesn't hide)

| Hidden ✅ | Not hidden ❌ |
|---|---|
| **Who you are** (identity, address) | The **content** of your request (the prompt) |
| **Linkability** of your uses to each other / to your purchase | |
| **Your balance / which credential** | |

- Hiding request *content* is FHE/TEE — **roadmap, not claimed**.
- Privacy strength = **anonymity-set size**: more credentials in the tree = stronger privacy.
- **Reputation is one application** of the same engine; **access credentials are the flagship**.

---

## Roadmap (explicitly OUT of this hackathon)

- **Acquisition:** agents pay from **Base + Solana** (where the x402 volume is); credentials are spent
  privately on Stellar. The public→private crossing is itself a privacy feature.
- **Real-world settlement:** convert value to **MXN / physical cash in LatAm** — the long-term moat.

---

## Takeaway

> **Public usage is surveillance; private access is what agents actually need. MicoPay makes Stellar the
> place where an agent consumes resources without exposing its information — verified with ZK on Soroban.**
