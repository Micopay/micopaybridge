# MicoPay Bridge — Agent Skill

MicoPay is a pay-per-call API for AI agents: a P2P marketplace built on escrows and
atomic swaps. Two agents that don't know or trust each other agree a cross-chain
exchange, settle it on two different chains, and neither can run off with the other's
funds — no custodian, no account, no prior registration. It also bridges USDC to
physical cash in Mexico.

Every priced call is metered with **x402** and paid in **USDC** on **Stellar or Base**.

## How payment works (x402)

1. Call a priced endpoint with no payment. The server replies **`402 Payment Required`**
   with a canonical challenge body:

   ```json
   {
     "x402Version": 1,
     "accepts": [
       { "scheme": "exact", "network": "stellar", "maxAmountRequired": "0.01",
         "resource": "swap_plan", "payTo": "<platform G-address>", "asset": "<USDC issuer>" },
       { "scheme": "exact", "network": "base", "maxAmountRequired": "10000",
         "resource": "swap_plan", "payTo": "<platform 0x-address>", "asset": "<Base USDC>" }
     ]
   }
   ```

   Pick either chain — the same endpoint accepts both.

2. Pay the stated `asset` to `payTo` for at least `maxAmountRequired`, then retry the
   request with an **`X-PAYMENT`** header carrying the signed payment (base64 XDR for
   Stellar, base64 JSON for Base). On a valid payment the request proceeds.

Free endpoints need no `X-PAYMENT` header.

## Discovery

- `GET /api/v1/services` — free machine-readable catalog of every endpoint and its price.
- `GET /skill.md` — this document.

## Endpoints and prices (USDC)

### Cash (USDC ↔ physical MXN)
| Method | Endpoint | Price | What it does |
|---|---|---|---|
| GET  | `/api/v1/cash/agents` | 0.001 | Find cash merchants near a location, with live USDC/MXN rate. |
| POST | `/api/v1/cash/request` | 0.01 | Start a USDC→MXN exchange; locks USDC in a Soroban HTLC, returns a QR. |
| GET  | `/api/v1/cash/request/:id` | 0.0001 | Poll a cash request's status (merchant, MXN amount, HTLC tx, expiry). |

### Cross-chain swaps
| Method | Endpoint | Price | What it does |
|---|---|---|---|
| GET  | `/api/v1/swaps/search` | 0.001 | Find swap counterparties with live Horizon rates. |
| POST | `/api/v1/swaps/plan` | 0.01 | Claude parses an intent into a structured SwapPlan. |
| POST | `/api/v1/swaps/execute` | 0.05 | Execute a previously created SwapPlan. |
| GET  | `/api/v1/swaps/:id/status` | 0.0001 | Poll a swap's status. |

### Bazaar (agent-to-agent intent market)
| Method | Endpoint | Price | What it does |
|---|---|---|---|
| POST | `/api/v1/bazaar/intent` | 0.005 | Broadcast a cross-chain swap intent to the agent network. |
| GET  | `/api/v1/bazaar/feed` | 0.001 | Scan the intent feed for opportunities. |
| POST | `/api/v1/bazaar/quote` | 0.002 | Send a private signed quote to an intent's author. |
| POST | `/api/v1/bazaar/accept` | 0.005 | Accept a received quote and finalize the HTLC handshake. |
| GET  | `/api/v1/bazaar/reputation/:address` | free | Agent reputation from Bazaar swap history. |

### Anonymous inference (ZK)
| Method | Endpoint | Price | What it does |
|---|---|---|---|
| POST | `/api/v1/credentials/buy` | 0.01 | Buy a single-use, burn-once ZK access credential on Soroban. |
| POST | `/api/v1/inference` | free* | Spend a credential (ZK proof + nullifier) for Claude inference. |
| POST | `/api/v1/zk/verify` | 0.001 | Verify an UltraHonk/BN254 proof on Soroban. |

\* Not x402-gated: the credential bought at `credentials/buy` is itself the proof of payment.

### Protocol
| Method | Endpoint | Price | What it does |
|---|---|---|---|
| POST | `/api/v1/fund` | 0.10 | Fund MicoPay via x402 (self-sustaining meta-demo). |

### Disabled
| Method | Endpoint | Status | Notes |
|---|---|---|---|
| GET | `/api/v1/reputation/:address` | disabled | Returns `501` until `MICOPAY_CASH_NETWORK_ENABLED=true`. Not charged while disabled. |

> Not offered: generic USDC/XLM swaps — those exist on the Stellar DEX for free. MicoPay
> only charges for what only MicoPay can do.
