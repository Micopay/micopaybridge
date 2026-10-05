#!/usr/bin/env bash
# Micopay Protocol — Full Demo Script
# Runs: service discovery → swap search → swap plan → fund micopay
# Requires: API running on localhost:3000

set -e

API="${API_URL:-http://localhost:3000}"
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo "🍄 Micopay Protocol Demo"
echo "========================"
echo ""

# Health check
echo -e "${BLUE}[0] Health check${NC}"
curl -s "$API/health" | python3 -m json.tool 2>/dev/null || curl -s "$API/health"
echo ""

# Service discovery (free)
echo -e "${BLUE}[1] Service discovery (free)${NC}"
echo -e "  $ curl $API/api/v1/services"
curl -s "$API/api/v1/services" | python3 -m json.tool 2>/dev/null | head -30
echo ""

# Swap search — trigger 402 first
echo -e "${BLUE}[2] Swap search — Step 1: trigger 402${NC}"
echo -e "  $ curl '$API/api/v1/swaps/search?sell_asset=USDC&buy_asset=XLM&amount=50'"
curl -s "$API/api/v1/swaps/search?sell_asset=USDC&buy_asset=XLM&amount=50" | python3 -m json.tool 2>/dev/null
echo ""

# Swap search — pay and get data
echo -e "${BLUE}[2] Swap search — Step 2: pay x402 ($0.001)${NC}"
echo -e "  $ curl -H 'X-Payment: mock:GDEMO:0.001' ..."
curl -s "$API/api/v1/swaps/search?sell_asset=USDC&buy_asset=XLM&amount=50" \
  -H "X-Payment: mock:GDEMO_AGENT:0.001" | python3 -m json.tool 2>/dev/null
echo ""

# Swap plan (Claude)
echo -e "${BLUE}[3] Swap plan — Claude parses intent ($0.01)${NC}"
echo -e "  ${YELLOW}Note: This calls Claude API — takes a few seconds${NC}"
curl -s -X POST "$API/api/v1/swaps/plan" \
  -H "X-Payment: mock:GDEMO_AGENT:0.01" \
  -H "Content-Type: application/json" \
  -d '{"intent":"swap 50 USDC for XLM, best rate","user_address":"GDEMO_USER"}' \
  | python3 -m json.tool 2>/dev/null
echo ""

# Fund Micopay — THE META-DEMO
echo -e "${GREEN}[4] Fund Micopay — THE META-DEMO ($0.10)${NC}"
echo -e "  The agent funds the project using the same x402 it just demonstrated."
echo -e "  $ curl -X POST '$API/api/v1/fund' -H 'X-Payment: mock:GDEMO:0.10'"
FUND_RESPONSE=$(curl -s -X POST "$API/api/v1/fund" \
  -H "X-Payment: mock:GDEMO_AGENT:0.10" \
  -H "Content-Type: application/json" \
  -d '{"message":"Demo complete — x402 works!"}')

echo "$FUND_RESPONSE" | python3 -m json.tool 2>/dev/null

TOTAL=$(echo "$FUND_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total_funded_usdc','?'))" 2>/dev/null || echo "?")
SUPPORTERS=$(echo "$FUND_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total_supporters','?'))" 2>/dev/null || echo "?")

echo ""
echo -e "${GREEN}✓ Demo complete!${NC}"
echo -e "  Total funded: \$${TOTAL} USDC"
echo -e "  Total supporters: ${SUPPORTERS}"
echo -e "  Verify on Stellar Expert: https://stellar.expert/explorer/testnet"
echo ""
