#!/usr/bin/env bash
# Demo A — ZKaaS rail validation (poseidon_preimage circuit)
#
# Demonstrates:
#   1. Valid proof for secret=123456789 → { verified: true }
#   2. Tampered public input → { verified: false }
#   3. Fee charged per on-chain verification (gas measurement)
#
# Requirements:
#   - WSL2 Ubuntu with nargo 1.0.0-beta.9 and bb 0.87.0
#   - API running: npm run dev (apps/api)
#   - ZK_VERIFIER_CONTRACT_ID set in .env
#
# Usage:
#   cd apps/api && bash demo/run_demo_a.sh [--api-url http://localhost:3000]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
API_URL="${API_URL:-http://localhost:3000}"
DEMO_DIR="$REPO_ROOT/apps/api/demo"
WSL_CIRCUIT="/mnt/c/Users/eric/Desktop/HACKATON/circuits/poseidon_preimage"
WSL_DEMO="/mnt/c/Users/eric/Desktop/HACKATON/apps/api/demo"

SECRET=123456789

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url) API_URL="$2"; shift 2;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

echo "======================================================================"
echo "  Demo A — ZKaaS Rail Validation (poseidon_preimage)"
echo "  Circuit: proves knowledge of a Pedersen hash pre-image"
echo "  API:     $API_URL"
echo "======================================================================"
echo

# ── Step 1: Compile circuit ───────────────────────────────────────────────────
echo "[1/5] Compiling poseidon_preimage circuit in WSL2..."
wsl -d Ubuntu-24.04 -- bash -c "
  set -e
  cd '$WSL_CIRCUIT'
  nargo compile
  echo '[ok] Compiled: target/poseidon_preimage.json'
"
echo

# ── Step 2: Generate witness + proof for secret=123456789 ────────────────────
echo "[2/5] Generating witness and UltraHonk proof for secret=$SECRET..."
wsl -d Ubuntu-24.04 -- bash -c "
  set -e
  cd '$WSL_CIRCUIT'

  # Compute Pedersen hash of the secret via nargo test
  HASH=\$(nargo test test_known_preimage --show-output 2>/dev/null | grep -E '^0x[0-9a-f]+$' | head -1)
  if [[ -z \"\$HASH\" ]]; then
    echo '[warn] Could not extract hash from test output; using Prover.toml as-is'
    HASH=\"0\"
  fi

  # Write Prover.toml
  printf 'secret = \"$SECRET\"\nhash = \"%s\"\n' \"\$HASH\" > Prover.toml

  # Generate witness
  nargo execute witness

  # Generate proof
  mkdir -p ~/zkwork/demo_a
  cp target/poseidon_preimage.json ~/zkwork/demo_a/
  cp target/witness.gz ~/zkwork/demo_a/
  cd ~/zkwork/demo_a
  ~/.bb/bb prove -b poseidon_preimage.json -w witness.gz -o proof/
  cp proof/proof '$WSL_DEMO/demo_a_proof.bin'
  echo \"[ok] Proof: \$(wc -c < proof/proof) bytes\"
"
echo

# ── Step 3: Submit valid proof → expect { verified: true } ──────────────────
echo "[3/5] Submitting VALID proof to ZKaaS → expect verified: true..."

PROOF_B64=$(base64 -w0 "$DEMO_DIR/demo_a_proof.bin" 2>/dev/null || base64 "$DEMO_DIR/demo_a_proof.bin")

# Get the Pedersen hash from the Prover.toml written in WSL2
HASH_FROM_TOML=$(wsl -d Ubuntu-24.04 -- bash -c "
  grep '^hash' '$WSL_CIRCUIT/Prover.toml' | cut -d'\"' -f2
" 2>/dev/null || echo "0")

if [[ "$HASH_FROM_TOML" == "0" || -z "$HASH_FROM_TOML" ]]; then
  echo "  [warn] Could not read Pedersen hash; proof submission may fail"
  HASH_DEC="0"
elif [[ "$HASH_FROM_TOML" == 0x* ]]; then
  HASH_DEC=$(python3 -c "print(int('$HASH_FROM_TOML', 16))")
else
  HASH_DEC="$HASH_FROM_TOML"
fi

VALID_RESPONSE=$(curl -s -X POST "$API_URL/api/v1/zk/verify" \
  -H "Content-Type: application/json" \
  -H "X-Payment: mock:GPAYER000000000000000000000000000000000000000000000000000:0.001" \
  -d "{
    \"circuit_id\": \"poseidon_preimage\",
    \"proof\": \"$PROOF_B64\",
    \"public_inputs\": [\"$HASH_DEC\"]
  }")

echo "  Response: $VALID_RESPONSE"
VALID_VERIFIED=$(echo "$VALID_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('verified','?'))" 2>/dev/null || echo "?")
if [[ "$VALID_VERIFIED" == "True" || "$VALID_VERIFIED" == "true" ]]; then
  echo "  ✓ verified: true — valid proof accepted"
else
  echo "  [result] $VALID_VERIFIED"
fi
echo

# ── Step 4: Submit tampered input → expect { verified: false } ──────────────
echo "[4/5] Submitting TAMPERED public_input → expect verified: false..."
TAMPERED_RESPONSE=$(curl -s -X POST "$API_URL/api/v1/zk/verify" \
  -H "Content-Type: application/json" \
  -H "X-Payment: mock:GPAYER000000000000000000000000000000000000000000000000000:0.001" \
  -d "{
    \"circuit_id\": \"poseidon_preimage\",
    \"proof\": \"$PROOF_B64\",
    \"public_inputs\": [\"9999999999999\"]
  }")
echo "  Response: $TAMPERED_RESPONSE"
TAMPERED_VERIFIED=$(echo "$TAMPERED_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('verified','?'))" 2>/dev/null || echo "?")
if [[ "$TAMPERED_VERIFIED" == "False" || "$TAMPERED_VERIFIED" == "false" ]]; then
  echo "  ✓ verified: false — tampered proof rejected"
else
  echo "  [result] $TAMPERED_VERIFIED"
fi
echo

# ── Step 5: Fetch fee_charged for the last verification tx ──────────────────
echo "[5/5] Measuring on-chain gas (fee_charged for last verification tx)..."
RPC_URL="${SOROBAN_RPC_URL:-https://soroban-testnet.stellar.org}"

# Query the most recent transaction by the API's signer account
FEES=$(python3 -c "
import urllib.request, json

rpc = '$RPC_URL'
# We can't easily get the last tx hash here without storing it from the API response.
# Instead, use Horizon to look up recent ops from the admin key.
admin_pub = '$(stellar keys address default 2>/dev/null || echo "")'
if not admin_pub:
    print('ADMIN public key not available (set ADMIN_SECRET_KEY and run stellar keys address default)')
else:
    url = f'https://horizon-testnet.stellar.org/accounts/{admin_pub}/operations?order=desc&limit=5'
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.loads(r.read())
        ops = data.get('_embedded', {}).get('records', [])
        for op in ops:
            tx_hash = op.get('transaction_hash', '')
            if tx_hash:
                tx_url = f'https://horizon-testnet.stellar.org/transactions/{tx_hash}'
                with urllib.request.urlopen(tx_url, timeout=10) as r2:
                    tx = json.loads(r2.read())
                fee = tx.get('fee_charged', '?')
                print(f'Last tx hash: {tx_hash}')
                print(f'fee_charged:  {fee} stroops ({int(fee)/10_000_000:.7f} XLM)')
                break
    except Exception as e:
        print(f'Could not fetch: {e}')
" 2>/dev/null || echo "  (Python fee fetch failed — check ADMIN_SECRET_KEY and Horizon)")
echo "  $FEES"
echo

echo "======================================================================"
echo "  DEMO A COMPLETE"
echo "  valid proof   → verified: $VALID_VERIFIED"
echo "  tampered input → verified: $TAMPERED_VERIFIED"
echo "  On-chain ZK verification gas ≈ 0.00005 XLM (expected per spec)"
echo "======================================================================"
