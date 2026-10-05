#!/usr/bin/env bash
# Deploy AtomicSwapHTLC contracts to Stellar testnet
# Requires: stellar CLI installed, PLATFORM_SECRET_KEY set

set -e

NETWORK="${STELLAR_NETWORK:-testnet}"
SECRET_KEY="${PLATFORM_SECRET_KEY:?PLATFORM_SECRET_KEY not set}"

echo "🍄 Deploying Micopay contracts to $NETWORK..."

# Build contracts
echo "[1/4] Building contracts..."
cd contracts
cargo build --target wasm32-unknown-unknown --release

WASM_SWAP="target/wasm32-unknown-unknown/release/atomic_swap.wasm"
WASM_ESCROW="target/wasm32-unknown-unknown/release/micopay_escrow.wasm"

# Deploy AtomicSwapHTLC (chain A)
echo "[2/4] Deploying AtomicSwapHTLC (chain A)..."
CONTRACT_A=$(stellar contract deploy \
  --wasm "$WASM_SWAP" \
  --source "$SECRET_KEY" \
  --network "$NETWORK" \
  2>&1 | tail -1)
echo "  Contract A: $CONTRACT_A"

# Deploy AtomicSwapHTLC (chain B — second instance for demo)
echo "[3/4] Deploying AtomicSwapHTLC (chain B — demo)..."
CONTRACT_B=$(stellar contract deploy \
  --wasm "$WASM_SWAP" \
  --source "$SECRET_KEY" \
  --network "$NETWORK" \
  2>&1 | tail -1)
echo "  Contract B: $CONTRACT_B"

# Deploy MicopayEscrow
echo "[4/4] Deploying MicopayEscrow..."
CONTRACT_ESCROW=$(stellar contract deploy \
  --wasm "$WASM_ESCROW" \
  --source "$SECRET_KEY" \
  --network "$NETWORK" \
  2>&1 | tail -1)
echo "  Escrow: $CONTRACT_ESCROW"

echo ""
echo "✓ Deployment complete! Add to .env:"
echo ""
echo "ATOMIC_SWAP_CONTRACT_ID=$CONTRACT_A"
echo "ATOMIC_SWAP_CONTRACT_B_ID=$CONTRACT_B"
echo "MICOPAY_ESCROW_CONTRACT_ID=$CONTRACT_ESCROW"
echo ""
