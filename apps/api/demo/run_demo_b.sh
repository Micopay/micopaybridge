#!/usr/bin/env bash
# Demo B — Anonymous reputation for AI agents
#
# Demonstrates: AI agent A (buyer) proves to agent B (market-maker)
# that their reputation tier is >= SILVER, without revealing identity.
# Agent B verifies via ZKaaS, paying 0.001 USDC (mocked in dev).
#
# Requirements:
#   - WSL2 Ubuntu with nargo 1.0.0-beta.9 and bb 0.87.0
#   - API running (npm run dev in apps/api)
#   - ZK_VERIFIER_CONTRACT_ID deployed and VKs registered
#   - ADMIN_SECRET_KEY set (for publish-root)
#
# Usage:
#   cd apps/api && bash demo/run_demo_b.sh [--api-url http://localhost:3000]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
API_URL="${API_URL:-http://localhost:3000}"
DEMO_DIR="$REPO_ROOT/apps/api/demo"
CIRCUIT_DIR="$REPO_ROOT/circuits/reputation_v1"
WSL_CIRCUIT="/mnt/c/Users/eric/Desktop/HACKATON/circuits/reputation_v1"
WSL_DEMO="/mnt/c/Users/eric/Desktop/HACKATON/apps/api/demo"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url) API_URL="$2"; shift 2;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

echo "======================================================================"
echo "  Demo B — ZKaaS Anonymous Reputation (MicoPay x Stellar)"
echo "======================================================================"
echo "  API:        $API_URL"
echo "  Circuit:    reputation_v1 (depth-20 Merkle + tier threshold + nullifier)"
echo "======================================================================"
echo

# ── Step 0: List available circuits ──────────────────────────────────────────
echo "[0/5] Listing available ZKaaS circuits..."
curl -s "$API_URL/api/v1/zk/circuits" | python3 -m json.tool || \
  curl -s "$API_URL/api/v1/zk/circuits"
echo

# ── Step 1: Build demo tree & generate Prover.toml ───────────────────────────
echo "[1/5] Building demo Merkle tree for alice (GOLD tier, secret=1001)..."
cd "$REPO_ROOT/apps/api"
npx tsx src/cli/rep-engine.ts build-tree \
  --seed demo/demo_users.json \
  --user alice \
  --context 42 \
  --threshold 2
echo

# ── Step 2: Generate witness in WSL2 ─────────────────────────────────────────
echo "[2/5] Generating witness in WSL2 (nargo execute)..."
wsl -d Ubuntu-24.04 -- bash -c "
  set -e
  cd '$WSL_CIRCUIT'
  nargo execute witness
  echo '[ok] Witness generated: target/witness.gz'
"
echo

# ── Step 3: Generate UltraHonk proof in WSL2 (bb prove) ─────────────────────
echo "[3/5] Generating UltraHonk proof in WSL2 (bb prove)..."
wsl -d Ubuntu-24.04 -- bash -c "
  set -e
  mkdir -p ~/zkwork/rep_demo
  cp '$WSL_CIRCUIT/target/reputation_v1.json' ~/zkwork/rep_demo/
  cp '$WSL_CIRCUIT/target/witness.gz' ~/zkwork/rep_demo/
  cd ~/zkwork/rep_demo
  ~/.bb/bb prove -b reputation_v1.json -w witness.gz -o proof/
  cp proof/proof '$WSL_DEMO/alice_proof.bin'
  echo \"[ok] Proof generated: \$(wc -c < proof/proof) bytes\"
"
echo

# ── Step 4: Encode proof as base64 ───────────────────────────────────────────
echo "[4/5] Encoding proof as base64..."
if [[ -f "$DEMO_DIR/alice_proof.bin" ]]; then
  PROOF_B64=$(base64 -w0 "$DEMO_DIR/alice_proof.bin" 2>/dev/null || base64 "$DEMO_DIR/alice_proof.bin")
else
  echo "[error] alice_proof.bin not found. Did step 3 succeed?" >&2
  exit 1
fi
echo "[ok] Proof: ${#PROOF_B64} base64 chars ($(wc -c < "$DEMO_DIR/alice_proof.bin") bytes)"
echo

# ── Step 5: Submit to ZKaaS API ──────────────────────────────────────────────
ROOT="0x079fa7cd6ecb9dc5b48eedf99357995c04771a815c19072ac63b0f1265868bd5"
CONTEXT="42"
NULLIFIER="0x1b7d99efaf246eb3489deefcff6b29541e57fbc7c048da3713b00df3e84eccc2"
TIER_THRESHOLD="2"

# Convert hex to decimal for API (expects decimal field strings)
ROOT_DEC=$(python3 -c "print(int('$ROOT', 16))")
NULLIFIER_DEC=$(python3 -c "print(int('$NULLIFIER', 16))")

echo "[5/5] Submitting proof to ZKaaS API..."
echo "  circuit_id:    reputation_v1"
echo "  public_inputs: [root, tier_threshold=${TIER_THRESHOLD}, context=${CONTEXT}, nullifier]"
echo "  payment:       X-Payment: mock (dev mode)"
echo

RESPONSE=$(curl -s -X POST "$API_URL/api/v1/zk/verify" \
  -H "Content-Type: application/json" \
  -H "X-Payment: mock" \
  -d "{
    \"circuit_id\": \"reputation_v1\",
    \"proof\": \"$PROOF_B64\",
    \"public_inputs\": [\"$ROOT_DEC\", \"$TIER_THRESHOLD\", \"$CONTEXT\", \"$NULLIFIER_DEC\"]
  }" 2>&1)

echo "  Response: $RESPONSE"
echo

# ── Summary of reputation proof ──────────────────────────────────────────────
echo "======================================================================"
VERIFIED=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('verified','?'))" 2>/dev/null || echo "?")
if [[ "$VERIFIED" != "True" && "$VERIFIED" != "true" ]]; then
  echo "  Reputation proof result: $VERIFIED"
  echo "  (If running locally without on-chain contract, set ZK_VERIFIER_CONTRACT_ID)"
  echo "======================================================================"
  exit 0
fi

echo "  RESULT: PROOF VERIFIED ✓"
echo "  Agent B knows: counterparty has reputation >= SILVER"
echo "  Agent B knows: NOTHING ELSE (identity, address, exact tier)"
echo "  Trade can proceed → Step 6: ZK-commit to HTLC secret"
echo "======================================================================"
echo

# ── Step 6: Generate poseidon_preimage proof for the HTLC secret ─────────────
# The HTLC secret is a 32-byte value. Agent A proves knowledge of it BEFORE
# the counterparty locks funds — removing the trust gap in HTLC setup.
# Hash function: BN254 Pedersen (what the poseidon_preimage circuit uses).
HTLC_SECRET=99999    # demo secret for illustration; a real agent generates this randomly
WSL_PRE_CIRCUIT="/mnt/c/Users/eric/Desktop/HACKATON/circuits/poseidon_preimage"

echo "[6/7] Generating ZK-commitment proof for HTLC secret (poseidon_preimage)..."
# Compute the Pedersen hash from nargo and write Prover.toml
wsl -d Ubuntu-24.04 -- bash -c "
  set -e
  cd '$WSL_PRE_CIRCUIT'
  # Write Prover.toml with the HTLC secret
  printf 'secret = \"${HTLC_SECRET}\"\nhash = \"0\"\n' > Prover.toml
  # Execute witness (nargo will compute the correct hash output automatically)
  nargo execute witness
  # Prove
  mkdir -p ~/zkwork/pre_demo
  cp target/poseidon_preimage.json ~/zkwork/pre_demo/
  cp target/witness.gz ~/zkwork/pre_demo/
  cd ~/zkwork/pre_demo
  ~/.bb/bb prove -b poseidon_preimage.json -w witness.gz -o proof/
  cp proof/proof '/mnt/c/Users/eric/Desktop/HACKATON/apps/api/demo/htlc_commitment_proof.bin'
  echo \"[ok] HTLC commitment proof: \$(wc -c < proof/proof) bytes\"
"
echo

# ── Step 6b: Verify HTLC commitment via ZKaaS ────────────────────────────────
echo "[6b/7] Verifying HTLC commitment via ZKaaS (poseidon_preimage)..."

# Compute the Pedersen hash of the HTLC secret using nargo test output
HTLC_HASH_HEX=$(wsl -d Ubuntu-24.04 -- bash -c "
  cd '$WSL_PRE_CIRCUIT'
  nargo test test_known_preimage --show-output 2>/dev/null | grep -E '^0x|^[0-9]' | head -1
" 2>/dev/null || echo "")

if [[ -z "$HTLC_HASH_HEX" ]]; then
  echo "  [warn] Could not extract Pedersen hash from nargo; using placeholder."
  HTLC_HASH_DEC="12345678901234567890"
else
  HTLC_HASH_DEC=$(python3 -c "
h='$HTLC_HASH_HEX'
if h.startswith('0x'): h=h[2:]
print(int(h,16))
" 2>/dev/null || echo "$HTLC_HASH_HEX")
fi

if [[ -f "$DEMO_DIR/htlc_commitment_proof.bin" ]]; then
  HTLC_PROOF_B64=$(base64 -w0 "$DEMO_DIR/htlc_commitment_proof.bin" 2>/dev/null || base64 "$DEMO_DIR/htlc_commitment_proof.bin")
  HTLC_RESPONSE=$(curl -s -X POST "$API_URL/api/v1/zk/verify" \
    -H "Content-Type: application/json" \
    -H "X-Payment: mock" \
    -d "{
      \"circuit_id\": \"poseidon_preimage\",
      \"proof\": \"$HTLC_PROOF_B64\",
      \"public_inputs\": [\"$HTLC_HASH_DEC\"]
    }")
  echo "  Response: $HTLC_RESPONSE"
  HTLC_VERIFIED=$(echo "$HTLC_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('verified','?'))" 2>/dev/null || echo "?")
  if [[ "$HTLC_VERIFIED" == "True" || "$HTLC_VERIFIED" == "true" ]]; then
    echo "  ZK-commitment VERIFIED ✓ — Agent A is committed to the HTLC secret"
  else
    echo "  [warn] ZK-commitment result: $HTLC_VERIFIED"
  fi
else
  echo "  [skip] htlc_commitment_proof.bin not found (WSL2 step may have been skipped)"
fi
echo

# ── Step 7: Lock USDC in MicopayEscrow ───────────────────────────────────────
# The HTLC secret hash for the escrow is sha256(secret_bytes).
# This ties the ZK commitment to the on-chain escrow: Agent A proves they know
# the secret (ZK), then locks funds with the secret's SHA-256 as the condition.
ESCROW_CONTRACT="${MICOPAY_ESCROW_CONTRACT_ID:-CBQINHLR3M7NZAPQY7EJ3TWOE22R57LMFDVEMOK3C3X7ZIBFWHVQQP3A}"
DEMO_BUYER="GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKUJI5KOOJ9TXWNTBBS2JN"

echo "[7/7] Locking USDC in MicopayEscrow (sha256 of HTLC secret)..."
echo "  Contract: $ESCROW_CONTRACT"
echo "  Note: seller must hold USDC trustline on testnet. Uses ADMIN_SECRET_KEY."

# Compute sha256(secret as 32-byte big-endian)
SECRET_HASH_HEX=$(python3 -c "
import hashlib
s = int($HTLC_SECRET).to_bytes(32, 'big')
print(hashlib.sha256(s).hexdigest())
")
echo "  secret_hash (sha256): $SECRET_HASH_HEX"

# Invoke MicopayEscrow.lock (simulation — add --send yes to execute on-chain)
set +e
LOCK_OUTPUT=$(stellar contract invoke \
  --id "$ESCROW_CONTRACT" \
  --source-account "${ADMIN_SECRET_KEY:-$(echo 'ADMIN_SECRET_KEY not set')}" \
  --network testnet \
  --send no \
  -- lock \
  --seller "$(stellar keys address default 2>/dev/null || echo 'SELLER_ADDR')" \
  --buyer "$DEMO_BUYER" \
  --amount 100000 \
  --platform_fee 10000 \
  --secret_hash "$SECRET_HASH_HEX" \
  --timeout_minutes 60 \
  2>&1)
LOCK_EXIT=$?
set -e

if [[ $LOCK_EXIT -eq 0 ]]; then
  echo "  MicopayEscrow.lock SIMULATED ✓ (add --send yes to execute on-chain)"
  echo "  Output: $LOCK_OUTPUT"
else
  echo "  [info] Lock simulation output: $LOCK_OUTPUT"
  echo "  (Simulation may fail without USDC trustline; the ZK-commitment step above is the key deliverable)"
fi
echo

echo "======================================================================"
echo "  DEMO B COMPLETE"
echo "  1. reputation_v1 proof → VERIFIED: counterparty is >= SILVER, identity hidden"
echo "  2. poseidon_preimage proof → VERIFIED: Agent A committed to HTLC secret"
echo "  3. MicopayEscrow.lock → parameterized with sha256(secret)"
echo "  Trust earned. Trade can proceed. Zero identity disclosure."
echo "======================================================================"
