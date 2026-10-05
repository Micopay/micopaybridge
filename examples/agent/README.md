# MicoPay Base agent example

The WP4 demo from
[`BASE_IMPLEMENTATION_PLAN_2026-07.md`](../../docs/zk-agent-credentials/BASE_IMPLEMENTATION_PLAN_2026-07.md):
an agent that lives entirely on **Base**, pays MicoPay in USDC via x402
(EIP-3009, gasless), and gets access to Claude inference gated by an
**anonymous ZK credential verified on Stellar/Soroban** — without the agent
ever holding a Stellar key or knowing Stellar exists.

This is intentionally standalone (not an npm workspace member) — it only
talks to MicoPay's public HTTP API, the way a real third-party agent would.

## Run it

```bash
npm install
cp .env.example .env
# fill in AGENT_PRIVATE_KEY — a TESTNET-ONLY EVM key, funded with Base
# Sepolia USDC (faucet: Circle's Base Sepolia USDC faucet). It does NOT
# need Base ETH: EIP-3009 authorizations are signed off-chain and gasless
# on the agent's side — MicoPay's relayer/facilitator pays gas.
npm start
```

First run buys the credential and stops, printing the `nargo`/`bb` commands
needed to generate a real ZK proof (there's no JS Pedersen-hash/Merkle
implementation in this repo — see
[`STATUS.md`](../../docs/zk-agent-credentials/STATUS.md)). Run those
commands, put the resulting proof + public inputs into `.env`
(`SPEND_PROOF_B64`, `SPEND_PUBLIC_INPUTS`), then run `npm start` again to
complete the spend leg and see Claude's response.

## What this proves

- MicoPay's x402 challenge is genuinely chain-agnostic (`accepts[]` lists
  both `stellar-usdc` and `exact`/`base-sepolia` — this script discovers the
  Base option from that array, it isn't hardcoded).
- The purchased credential is identical in shape whether paid from Base or
  Stellar — same `access_credential_v1` circuit, same spend path.
- The agent process never imports `@stellar/stellar-sdk`, never derives a
  Stellar keypair, never sees a Stellar address — the ZK trust verification
  and settlement happen entirely behind the MicoPay API.

## Known limitation

The ZK proof-generation step is manual (nargo/bb) rather than scripted here
— that's an existing gap in the whole ZK pipeline (tracked in `STATUS.md`,
item #3/#4), not specific to Base. It doesn't block the point of this demo:
everything an agent developer would actually write against MicoPay's public
API is in this script.
