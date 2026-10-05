# MicoPay — Private Resource Access for AI Agents

**AI agents consume paid resources — inference, data, APIs — by proving, with a
zero-knowledge proof verified on-chain, that they hold a valid, unspent access
credential. Nothing else: not who they are, not which credential, not their
balance. One of the first working ZK verifiers built on Stellar Soroban's new
BN254 host functions (Protocol 25/26).**

### The problem

The agent economy runs on pay-per-call x402 services, and every one of those
payments is public on-chain. Anyone — a competitor, the API provider, any
indexer — can reconstruct exactly what your agent consumes, how often, and
when. For a fund whose agent queries a specific data feed right before it
trades, or a product that only calls an expensive model for premium users,
**paying has become confessing your strategy.**

The usual "fix" — hide behind an API key — doesn't remove the surveillance, it
relocates it: now every call is tied to your identity in one provider's logs.
You've traded being watched by everyone for being watched perfectly by
someone.

MicoPay breaks that false choice. Payment stays public — it reveals exactly
one thing: that you bought credit. Usage becomes anonymous, unlinkable, and
single-use. **Base is the door; Stellar is the vault.**

### The idea, in one line

> Separate *paying* from *using*. Paying can be public. Using must be provable
> without saying who you are — and without anyone linking a use back to the
> purchase that funded it.

Think arcade tokens: you buy tokens in public, you spend one to play — proving
it's valid but never *which* token — and it burns on use. No reuse, no
tracking, no trust required.

### How it works

```
BUY    secret s → commitment C = H(s) → leaf in a Merkle tree
       → only the 32-byte ROOT is published on Soroban
SPEND  ZK proof: "I know the secret behind ONE leaf" + nullifier H(s)
       → reveals nothing about which leaf, the secret, or the spender
REUSE  same nullifier submitted again → rejected on-chain (double-spend dead)
```

A Noir/UltraHonk circuit (`access_credential_v1`) generates the proof
off-chain; the `ZkVerifierRegistry` Soroban contract verifies it on-chain
using Stellar's BN254 host functions and burns the nullifier. Buying is x402
pay-per-credential; spending is gated by the proof — not by a second payment,
not by an API key.

### Live on Stellar testnet

- [`ZkVerifierRegistry`](https://stellar.expert/explorer/testnet/contract/CCZHC456HBJRTZP45V5AT3ILHP3MOVH36MHR7HUWQHV2JLN6MJEITXB2)
  — deployed, with 3 circuits registered: `poseidon_preimage`,
  `reputation_v1`, `access_credential_v1`.
- Full pipeline exercised end-to-end against testnet: **buy → spend → Claude
  responds → replay attempt → `NullifierAlreadyUsed` rejected on-chain.** The
  system defends itself in public.
- Battle-tested mid-hackathon: we ran an adversarial security review
  (frontier-model red team, full report in the repo) against the payment/ZK
  pipeline and **closed all 7 findings** — real on-chain settlement
  verification, durable replay protection, fail-closed root checks,
  root-hijack prevention, hot/cold key separation, nullifier lifetime pinned
  to the network maximum — and redeployed. Not "we got audited": we got
  audited *and shipped every fix*.

### Built this hackathon: pay from Base, verify on Stellar

Agents live where the x402 volume is — Base. So MicoPay accepts **EIP-3009
(`transferWithAuthorization`) USDC payments on Base**: an agent pays gaslessly
from Base Sepolia and receives the exact same anonymous credential a Stellar
payer would. The verification is built the paranoid way — the EIP-712 domain
is constructed server-side with the chain ID and USDC contract pinned (never
trusted from the client), replay protection is an atomic reservation in
Postgres keyed the same way the token contract keys authorizations, and
settlement is facilitator-first with a self-submit fallback. A complete
example agent (`examples/agent/`) discovers the 402 challenge, signs the
authorization, buys the credential, generates the ZK proof, and spends it —
**without ever touching a Stellar account.** Cross-chain privacy where the
agent never has to learn what a trustline is.

### Try it

```bash
git clone <REPO_URL> && cd apps/api && npm i && npm run dev
curl -i localhost:3000/api/v1/inference
#  → 402 Payment Required, with the x402 challenge (stellar + base accepted)
#  buy a credential, generate the proof, spend it — full walkthrough in the README
```

### What's hidden vs. what isn't

| Hidden ✅ | Not hidden ❌ |
|---|---|
| Who is spending (identity / payer address) | The content of your request |
| Which credential was used, or how many remain | That a purchase happened (x402 is public — by design) |
| Any link between a spend and the purchase that funded it | Spend timing (shrinks with batched issuance) |

Privacy scales with the anonymity set — it grows with every credential in the
tree. Hiding request *content* is FHE/TEE territory: explicitly roadmap, not
claimed here. We tell you exactly what you get, because a privacy product
that oversells is a surveillance product with better marketing.

### Stack

Noir + UltraHonk (proofs) · Soroban/Rust (`ZkVerifierRegistry`, BN254 host
functions) · Fastify/TypeScript (x402 middleware, credential issuance,
inference gateway) · viem (EIP-3009 signing & verification) · Postgres
(durable replay protection) · Claude (the gated resource).
