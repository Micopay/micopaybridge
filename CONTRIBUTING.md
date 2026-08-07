# Contributing to MicoPay

MicoPay is participating in **[Stellar Drips Wave 4](https://www.drips.network/wave/stellar)**. Contributions are scoped to the retail mobile app — not the whole monorepo.

> Before opening a PR, skim this file end to end. It is the contract we review PRs against.

---

## Wave focus

One flow over many demos. The Wave is organized around making **Core Retail Flow** — trade creation, state, cancel, timeout, refund, receipt — work reliably end to end.

Every other milestone (Backend Hardening, Merchant Operations, Frontend Quality, Store Readiness, Documentation) exists to make that flow trustworthy. If you are unsure where to start, pick an issue from [**Core Retail Flow**](https://github.com/ericmt-98/micopay-protocol/milestone/2) first.

---

## In-scope paths

- `micopay/frontend/` — retail mobile app (React/Vite, port 5181)
- `micopay/backend/` — retail backend (Node/Fastify, port 3002)
- `docs/` — shared product, UX, and team guides

## Out-of-scope unless an issue explicitly opens it

- `apps/api/` (agent x402 protocol API)
- `apps/web/` (protocol dashboard)
- `contracts/` (Soroban contracts)
- `stitch_remix_of_micopay/`, old prototypes, deployment configs, and operations internals

PRs that touch out-of-scope paths will be asked to split or rescope.

---

## Getting started

1. Fork the repo and clone your fork.
2. Install dependencies from the repo root:
   ```bash
   npm install
   ```
3. Run the retail app locally (two terminals):
   ```bash
   cd micopay/backend && npm run dev   # http://localhost:3002
   cd micopay/frontend && npm run dev  # http://localhost:5181
   ```
4. Read the four core docs before picking an issue:
   - [`docs/PRODUCT_SCOPE.md`](./docs/PRODUCT_SCOPE.md) — what we are building and why
   - [`docs/RETAIL_ROADMAP.md`](./docs/RETAIL_ROADMAP.md) — the phased execution plan
   - [`docs/UX_MANIFESTO.md`](./docs/UX_MANIFESTO.md) — the trust and UX bar every PR is reviewed against
   - [`docs/DRIPS_TEAM_GUIDE.md`](./docs/DRIPS_TEAM_GUIDE.md) — how issues, reviews, and merges work during the Wave
5. Pick an issue from the [open milestones](https://github.com/ericmt-98/micopay-protocol/milestones).

---

## Picking an issue

- Look for issues labeled [`wave:good-first`](https://github.com/ericmt-98/micopay-protocol/labels/wave%3Agood-first) if it is your first PR.
- Comment on the issue asking to be assigned **before** you start work. We assign one contributor per issue to avoid duplicated effort.
- If nobody responds within 48 hours, tag the maintainer on the issue.
- Do not open PRs against issues labeled `wave:blocked` or `wave:needs-product` until the block is cleared.

## Labels we use

- **Wave surface:** `wave:retail`, `wave:frontend`, `wave:backend`, `wave:merchant`, `wave:trust`, `wave:docs`
- **Complexity:** `complexity: low`, `complexity: medium`, `complexity: high`
- **Flow control:** `wave:good-first`, `wave:blocked`, `wave:needs-product`
- **Rewards:** `Stellar Wave` marks work eligible for Drips

---

## Milestones

| Milestone | Focus |
|---|---|
| [Core Retail Flow](https://github.com/ericmt-98/micopay-protocol/milestone/2) | **Wave priority.** Trade creation, detail view, state machine UX, cancel / timeout / refund, receipts, history linked to real states |
| [Backend Hardening](https://github.com/ericmt-98/micopay-protocol/milestone/7) | Auth persistence, audit log, error taxonomy, rate limiting, replay protection, structured logging |
| [Merchant Operations](https://github.com/ericmt-98/micopay-protocol/milestone/3) | Merchant onboarding, profile, availability, limits, trade inbox |
| [Frontend Quality](https://github.com/ericmt-98/micopay-protocol/milestone/4) | Empty states, a11y pass, loading skeletons — polish outside the core flow |
| [Store Readiness](https://github.com/ericmt-98/micopay-protocol/milestone/6) | Account deletion, privacy, support path, reviewer mode, store compliance |
| [Documentation](https://github.com/ericmt-98/micopay-protocol/milestone/8) | Per-folder READMEs, env docs, local setup |

---

## What a good PR looks like

- Solves the issue as scoped (no side quests)
- Does not touch out-of-scope paths
- Matches the tone of [`docs/UX_MANIFESTO.md`](./docs/UX_MANIFESTO.md) for anything user-facing
- Includes local test notes when behavior changes (what you ran, what you saw)
- Stays under the complexity tier declared on the issue
- References the issue number in the PR description (`Closes #123`)

Review SLA during the Wave: **first review within 24 hours**.

### Commit and PR style

- Keep commits focused. One logical change per commit is ideal.
- PR title: short, imperative mood (`fix: empty state on history`, not `Fixed the empty state`).
- PR description should answer: what changed, why, how to test, and which issue it closes.

---

## Rewards

Rewards are distributed by [Drips](https://www.drips.network/wave/stellar) — not by the MicoPay maintainers — as a proportional share of the Wave 4 reward pool funded by the Stellar Development Foundation.

Points per issue are fixed by Drips based on the `complexity` label set on the issue:

| Complexity label | Points | Typical work |
|---|---:|---|
| `complexity: low` | 100 | Typos, empty states, small copy fixes, tiny tests |
| `complexity: medium` | 150 | Self-contained screen, endpoint, state handling, validation |
| `complexity: high` | 200 | Complex features, refactors, or new integrations |

Your final payout = (your points ÷ total points earned across all contributors in the Wave) × Wave 4 reward pool. Only issues labeled `Stellar Wave` count. See [Drips' contributor guide](https://docs.drips.network/wave/contributors/solving-issues-and-earning-rewards/) for details on withdrawals and timing.

---

## Code of Conduct

Be direct, be kind, and assume good intent. Disrespectful behavior in issues, PRs, or reviews is grounds for removal from the Wave.

## Getting help

- **Unclear issue scope?** Comment on the issue.
- **Blocked on a product decision?** Tag the maintainer and add the `wave:needs-product` label.
- **General questions about the Wave?** Check [`docs/DRIPS_TEAM_GUIDE.md`](./docs/DRIPS_TEAM_GUIDE.md) first.
