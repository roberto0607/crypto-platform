#!/usr/bin/env bash
set -euo pipefail

# Phase 6 PR1 — PnL + Positions Smoke Test
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

echo "=== Phase 6 PR1: PnL + Positions Smoke Test ==="

# ── Setup ──
echo "Setup: Register user, create assets, wallets, pair"

REG=$(api POST /auth/register "" "{\"email\":\"pnl${TS}@test.com\",\"password\":\"testpass123\"}")
LOGIN=$(api POST /auth/login "" "{\"email\":\"pnl${TS}@test.com\",\"password\":\"testpass123\"}")
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
USER_ID=$(echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['user']['id'])")

# Promote to admin
docker exec cp_postgres psql -U cp -d cp -c "UPDATE users SET role='ADMIN' WHERE id='${USER_ID}'" > /dev/null 2>&1
LOGIN2=$(api POST /auth/login "" "{\"email\":\"pnl${TS}@test.com\",\"password\":\"testpass123\"}")
TOKEN=$(echo "$LOGIN2" | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")

# Create assets
BTC=$(api POST /admin/assets "$TOKEN" "{\"symbol\":\"PBTC${TS}\",\"name\":\"PnlBTC${TS}\",\"decimals\":8}")
BTC_ID=$(echo "$BTC" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

USDT=$(api POST /admin/assets "$TOKEN" "{\"symbol\":\"PUSDT${TS}\",\"name\":\"PnlUSDT${TS}\",\"decimals\":8}")
USDT_ID=$(echo "$USDT" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

# Create wallets + fund
W_BTC=$(api POST /wallets "$TOKEN" "{\"assetId\":\"${BTC_ID}\"}")
W_BTC_ID=$(echo "$W_BTC" | python3 -c "import sys,json; print(json.load(sys.stdin)['wallet']['id'])")
W_USDT=$(api POST /wallets "$TOKEN" "{\"assetId\":\"${USDT_ID}\"}")
W_USDT_ID=$(echo "$W_USDT" | python3 -c "import sys,json; print(json.load(sys.stdin)['wallet']['id'])")

api POST "/admin/wallets/${W_USDT_ID}/credit" "$TOKEN" '{"amount":"500000"}' > /dev/null
api POST "/admin/wallets/${W_BTC_ID}/credit" "$TOKEN" '{"amount":"10"}' > /dev/null

# Create pair
PAIR=$(api POST /admin/pairs "$TOKEN" "{\"baseAssetId\":\"${BTC_ID}\",\"quoteAssetId\":\"${USDT_ID}\",\"symbol\":\"PBTC_USDT_${TS}\",\"feeBps\":30}")
PAIR_ID=$(echo "$PAIR" | python3 -c "import sys,json; print(json.load(sys.stdin)['pair']['id'])")

# Set last_price = 50000
api PATCH "/admin/pairs/${PAIR_ID}/price" "$TOKEN" '{"price":"50000"}' > /dev/null

# ── Test 1: BUY 1 BTC ──
echo ""
echo "--- Test 1: MARKET BUY 1 BTC at 50000 ---"
BUY=$(api POST /orders "$TOKEN" "{\"pairId\":\"${PAIR_ID}\",\"side\":\"BUY\",\"type\":\"MARKET\",\"qty\":\"1\"}")
BUY_OK=$(echo "$BUY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))")
check "BUY order OK" "$([[ "$BUY_OK" == "True" ]] && echo true || echo false)" "$(echo "$BUY" | head -c 200)"

# Check position after BUY
POSITIONS=$(api GET "/positions?pairId=${PAIR_ID}" "$TOKEN")
POS_QTY=$(echo "$POSITIONS" | python3 -c "import sys,json; p=json.load(sys.stdin)['positions']; print(p[0]['base_qty'] if p else '0')")
check "Position base_qty = 1" "$([[ $(python3 -c "print('true' if float('$POS_QTY') == 1.0 else 'false')") == "true" ]] && echo true || echo false)" "qty=$POS_QTY"

AVG_ENTRY=$(echo "$POSITIONS" | python3 -c "import sys,json; p=json.load(sys.stdin)['positions']; print(p[0]['avg_entry_price'] if p else '0')")
check "avg_entry_price = 50000" "$([[ $(python3 -c "print('true' if float('$AVG_ENTRY') == 50000.0 else 'false')") == "true" ]] && echo true || echo false)" "avg=$AVG_ENTRY"

# ── Test 2: SELL 1 BTC at higher price ──
echo ""
echo "--- Test 2: Set price to 52000, MARKET SELL 1 BTC ---"
api PATCH "/admin/pairs/${PAIR_ID}/price" "$TOKEN" '{"price":"52000"}' > /dev/null

SELL=$(api POST /orders "$TOKEN" "{\"pairId\":\"${PAIR_ID}\",\"side\":\"SELL\",\"type\":\"MARKET\",\"qty\":\"1\"}")
SELL_OK=$(echo "$SELL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))")
check "SELL order OK" "$([[ "$SELL_OK" == "True" ]] && echo true || echo false)" "$(echo "$SELL" | head -c 200)"

# ── Test 3: Check realized PnL ──
echo ""
echo "--- Test 3: Check realized PnL ---"
POSITIONS2=$(api GET "/positions?pairId=${PAIR_ID}" "$TOKEN")
REALIZED=$(echo "$POSITIONS2" | python3 -c "import sys,json; p=json.load(sys.stdin)['positions']; print(p[0]['realized_pnl_quote'] if p else '0')")
REALIZED_GT_ZERO=$(python3 -c "print('true' if float('$REALIZED') > 0 else 'false')")
check "realized_pnl > 0" "$REALIZED_GT_ZERO" "realized=$REALIZED"

POS_QTY2=$(echo "$POSITIONS2" | python3 -c "import sys,json; p=json.load(sys.stdin)['positions']; print(p[0]['base_qty'] if p else '999')")
check "Position closed (qty=0)" "$([[ $(python3 -c "print('true' if float('$POS_QTY2') == 0.0 else 'false')") == "true" ]] && echo true || echo false)" "qty=$POS_QTY2"

# ── Test 4: PnL summary ──
echo ""
echo "--- Test 4: PnL summary ---"
SUMMARY=$(api GET /pnl/summary "$TOKEN")
SUM_REALIZED=$(echo "$SUMMARY" | python3 -c "import sys,json; print(json.load(sys.stdin)['summary']['total_realized_pnl'])")
SUM_REALIZED_GT_ZERO=$(python3 -c "print('true' if float('$SUM_REALIZED') > 0 else 'false')")
check "summary total_realized_pnl > 0" "$SUM_REALIZED_GT_ZERO" "total_realized=$SUM_REALIZED"

FEES=$(echo "$SUMMARY" | python3 -c "import sys,json; print(json.load(sys.stdin)['summary']['total_fees_paid'])")
FEES_GT_ZERO=$(python3 -c "print('true' if float('$FEES') > 0 else 'false')")
check "summary total_fees_paid > 0" "$FEES_GT_ZERO" "fees=$FEES"

# ── Test 5: Equity series ──
echo ""
echo "--- Test 5: Equity series ---"
EQUITY=$(api GET /equity "$TOKEN")
EQ_COUNT=$(echo "$EQUITY" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('series',[])))")
check "Equity snapshots exist" "$([[ "$EQ_COUNT" -ge 1 ]] && echo true || echo false)" "count=$EQ_COUNT"

# ── Test 6: Stats endpoint ──
echo ""
echo "--- Test 6: /stats endpoint ---"
STATS=$(api GET /stats "$TOKEN")
STATS_OK=$(echo "$STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print('True' if d.get('ok') and 'positions' in d and 'summary' in d else 'False')")
check "/stats has positions + summary" "$([[ "$STATS_OK" == "True" ]] && echo true || echo false)"

echo ""
echo "=== PnL + Positions smoke test passed ==="
