#!/usr/bin/env bash
set -euo pipefail

# Phase 6 PR1 — Replay + Fees Smoke Test
# Requires: API running on localhost:3001, PostgreSQL up

BASE="http://localhost:3001"
TS=$(date +%s | tail -c 5)

api() {
    local method=$1 path=$2 token=${3:-} body=${4:-}
    local cmd=(curl -s -X "$method" "${BASE}${path}")
    [[ -n "$token" ]] && cmd+=(-H "Authorization: Bearer $token")
    [[ -n "$body" ]] && cmd+=(-H "Content-Type: application/json" -d "$body")
    "${cmd[@]}"
}

check() {
    local label=$1 condition=$2 detail=${3:-}
    if [[ "$condition" == "true" ]]; then
        echo "  [PASS] $label"
    else
        echo "  [FAIL] $label — $detail"
        exit 1
    fi
}

echo "=== Phase 6 PR1: Replay + Fees Smoke Test ==="

# ── Setup ──
echo "Setup: Register user, create assets, wallets, pair, candle"

REG=$(api POST /auth/register "" "{\"email\":\"replay${TS}@test.com\",\"password\":\"testpass123\"}")
LOGIN=$(api POST /auth/login "" "{\"email\":\"replay${TS}@test.com\",\"password\":\"testpass123\"}")
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
USER_ID=$(echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['user']['id'])")

# Promote to admin
docker exec cp_postgres psql -U cp -d cp -c "UPDATE users SET role='ADMIN' WHERE id='${USER_ID}'" > /dev/null 2>&1
LOGIN2=$(api POST /auth/login "" "{\"email\":\"replay${TS}@test.com\",\"password\":\"testpass123\"}")
TOKEN=$(echo "$LOGIN2" | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")

# Create assets
BTC=$(api POST /admin/assets "$TOKEN" "{\"symbol\":\"RBTC${TS}\",\"name\":\"ReplayBTC${TS}\",\"decimals\":8}")
BTC_ID=$(echo "$BTC" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

USDT=$(api POST /admin/assets "$TOKEN" "{\"symbol\":\"RUSDT${TS}\",\"name\":\"ReplayUSDT${TS}\",\"decimals\":8}")
USDT_ID=$(echo "$USDT" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

# Create wallets + fund
W_BTC=$(api POST /wallets "$TOKEN" "{\"assetId\":\"${BTC_ID}\"}")
W_BTC_ID=$(echo "$W_BTC" | python3 -c "import sys,json; print(json.load(sys.stdin)['wallet']['id'])")
W_USDT=$(api POST /wallets "$TOKEN" "{\"assetId\":\"${USDT_ID}\"}")
W_USDT_ID=$(echo "$W_USDT" | python3 -c "import sys,json; print(json.load(sys.stdin)['wallet']['id'])")

api POST "/admin/wallets/${W_USDT_ID}/credit" "$TOKEN" '{"amount":"500000"}' > /dev/null
api POST "/admin/wallets/${W_BTC_ID}/credit" "$TOKEN" '{"amount":"10"}' > /dev/null

# Create pair with maker/taker fees
PAIR=$(api POST /admin/pairs "$TOKEN" "{\"baseAssetId\":\"${BTC_ID}\",\"quoteAssetId\":\"${USDT_ID}\",\"symbol\":\"RBTC_USDT_${TS}\",\"feeBps\":30,\"makerFeeBps\":2,\"takerFeeBps\":5}")
PAIR_ID=$(echo "$PAIR" | python3 -c "import sys,json; print(json.load(sys.stdin)['pair']['id'])")

# Set last_price
api PATCH "/admin/pairs/${PAIR_ID}/price" "$TOKEN" '{"price":"50000"}' > /dev/null

# Insert a deterministic candle via SQL
CANDLE_TS="2024-01-01T00:00:00Z"
docker exec cp_postgres psql -U cp -d cp -c \
  "INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
   VALUES ('${PAIR_ID}', '1m', '${CANDLE_TS}', 50000, 50500, 49500, 50200, 100)
   ON CONFLICT DO NOTHING" > /dev/null 2>&1

# Start replay session
echo ""
echo "--- Test 1: Start replay session ---"
START_REPLAY=$(api POST /replay/start "$TOKEN" "{\"pairId\":\"${PAIR_ID}\",\"startTs\":\"${CANDLE_TS}\",\"timeframe\":\"1m\",\"speed\":1}")
IS_ACTIVE=$(echo "$START_REPLAY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session',{}).get('is_active', False))")
check "Replay session active" "$([[ "$IS_ACTIVE" == "True" ]] && echo true || echo false)" "is_active=$IS_ACTIVE"

# Place MARKET BUY during replay
echo ""
echo "--- Test 2: MARKET BUY during replay ---"
ORDER=$(api POST /orders "$TOKEN" "{\"pairId\":\"${PAIR_ID}\",\"side\":\"BUY\",\"type\":\"MARKET\",\"qty\":\"1\"}")
ORDER_OK=$(echo "$ORDER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))")
check "Order placed" "$([[ "$ORDER_OK" == "True" ]] && echo true || echo false)" "$(echo "$ORDER" | python3 -m json.tool 2>/dev/null || echo "$ORDER")"

STATUS=$(echo "$ORDER" | python3 -c "import sys,json; print(json.load(sys.stdin)['order']['status'])")
check "Order FILLED" "$([[ "$STATUS" == "FILLED" ]] && echo true || echo false)" "status=$STATUS"

FILL_COUNT=$(echo "$ORDER" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['fills']))")
check "Has fills" "$([[ "$FILL_COUNT" -ge 1 ]] && echo true || echo false)" "fills=$FILL_COUNT"

# Check fee_amount > 0
echo ""
echo "--- Test 3: Fee charged on fill ---"
FEE=$(echo "$ORDER" | python3 -c "import sys,json; print(json.load(sys.stdin)['fills'][0]['fee_amount'])")
FEE_GT_ZERO=$(python3 -c "print('true' if float('$FEE') > 0 else 'false')")
check "fee_amount > 0" "$FEE_GT_ZERO" "fee=$FEE"

# Check positions updated
echo ""
echo "--- Test 4: Position created ---"
POSITIONS=$(api GET "/positions?pairId=${PAIR_ID}" "$TOKEN")
POS_COUNT=$(echo "$POSITIONS" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('positions',[])))")
check "Position exists" "$([[ "$POS_COUNT" -ge 1 ]] && echo true || echo false)" "count=$POS_COUNT"

BASE_QTY=$(echo "$POSITIONS" | python3 -c "import sys,json; print(json.load(sys.stdin)['positions'][0]['base_qty'])")
check "base_qty = 1" "$([[ $(python3 -c "print('true' if float('$BASE_QTY') == 1.0 else 'false')") == "true" ]] && echo true || echo false)" "base_qty=$BASE_QTY"

echo ""
echo "=== Replay + Fees smoke test passed ==="
