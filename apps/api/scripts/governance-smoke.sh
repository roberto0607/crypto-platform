#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:3001"
EMAIL="gov-smoke-$(date +%s)@example.com"
ADMIN_EMAIL="gov-admin-$(date +%s)@example.com"
PASS="SmokeTest1234"
COOKIES="/tmp/gov-smoke-cookies.txt"
ADMIN_COOKIES="/tmp/gov-smoke-admin-cookies.txt"
PASS_COUNT=0
FAIL_COUNT=0

rm -f "$COOKIES" "$ADMIN_COOKIES"

check() {
  local label="$1" ok="$2" detail="${3:-}"
  if [ "$ok" = "true" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  PASS: $label ${detail:+($detail)}"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "  FAIL: $label ${detail:+($detail)}"
  fi
}

echo "=== 1. Register admin + trader ==="
curl -sf -X POST "$BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PASS\"}" || true

curl -sf -X POST "$BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" || true
echo " OK"

echo "=== 2. Login admin ==="
ADMIN_LOGIN=$(curl -sf -c "$ADMIN_COOKIES" -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PASS\"}")
ADMIN_ID=$(echo "$ADMIN_LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['user']['id'])")

docker exec cp_postgres psql -U cp -d cp -c \
  "UPDATE users SET role = 'ADMIN' WHERE id = '$ADMIN_ID';" > /dev/null

ADMIN_LOGIN=$(curl -sf -c "$ADMIN_COOKIES" -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PASS\"}")
ADMIN_TOKEN=$(echo "$ADMIN_LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
echo " OK"

echo "=== 3. Login trader ==="
TRADER_LOGIN=$(curl -sf -c "$COOKIES" -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
TOKEN=$(echo "$TRADER_LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
TRADER_ID=$(echo "$TRADER_LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['user']['id'])")
echo " OK"

echo "=== 4. Create assets + pair + wallets ==="
SHORT=$(date +%s | cut -c 6-)
BASE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"GB$SHORT\",\"name\":\"Gov BTC\",\"decimals\":8}")
BASE_ASSET_ID=$(echo "$BASE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

QUOTE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"GQ$SHORT\",\"name\":\"Gov USD\",\"decimals\":2}")
QUOTE_ASSET_ID=$(echo "$QUOTE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

PAIR=$(curl -sf -X POST "$BASE/admin/pairs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"baseAssetId\":\"$BASE_ASSET_ID\",\"quoteAssetId\":\"$QUOTE_ASSET_ID\",\"symbol\":\"GP$SHORT\",\"feeBps\":5}")
PAIR_ID=$(echo "$PAIR" | python3 -c "import sys,json; print(json.load(sys.stdin)['pair']['id'])")

curl -sf -X PATCH "$BASE/admin/pairs/$PAIR_ID/price" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"price\":\"50000\"}" > /dev/null

# Create wallets + credit
BW=$(curl -sf -X POST "$BASE/wallets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"assetId\":\"$BASE_ASSET_ID\"}")

QW=$(curl -sf -X POST "$BASE/wallets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"assetId\":\"$QUOTE_ASSET_ID\"}")
QW_ID=$(echo "$QW" | python3 -c "import sys,json; print(json.load(sys.stdin)['wallet']['id'])")

curl -sf -X POST "$BASE/admin/wallets/$QW_ID/credit" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"amount\":\"1000000\"}" > /dev/null

# Insert candle + start replay for snapshot
CANDLE_TS="2024-01-01T00:00:00Z"
docker exec cp_postgres psql -U cp -d cp -c \
  "INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
   VALUES ('${PAIR_ID}', '1m', '${CANDLE_TS}', 50000, 50500, 49500, 50200, 100)
   ON CONFLICT DO NOTHING" > /dev/null 2>&1

curl -sf -X POST "$BASE/replay/start" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"startTs\":\"$CANDLE_TS\",\"timeframe\":\"1m\",\"speed\":1}" > /dev/null
echo " OK"

echo "=== 5. Set tight account limits ==="
# max_daily_notional_quote=200 (price=50000, qty=0.001 → notional=50, so 4 orders max)
# max_open_orders=2
LIMITS=$(curl -sf -X PUT "$BASE/v1/admin/account-limits" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$TRADER_ID\",\"maxDailyNotionalQuote\":\"200\",\"maxOpenOrders\":2}")
HAS_STATUS=$(echo "$LIMITS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('account_status',''))")
check "PUT account-limits returns ACTIVE" "$([[ "$HAS_STATUS" == "ACTIVE" ]] && echo true || echo false)" "status=$HAS_STATUS"

echo "=== 6. GET account limits ==="
GET_LIMITS=$(curl -sf "$BASE/v1/admin/account-limits?userId=$TRADER_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
GOT_NOTIONAL=$(echo "$GET_LIMITS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('max_daily_notional_quote',''))")
check "GET account-limits returns notional" "$([[ "$GOT_NOTIONAL" == "200.00000000" ]] && echo true || echo false)" "notional=$GOT_NOTIONAL"

echo "=== 7. Place order within daily limit (notional=50) ==="
BUY1=$(curl -sf -X POST "$BASE/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"side\":\"BUY\",\"type\":\"MARKET\",\"qty\":\"0.001\"}")
BUY1_STATUS=$(echo "$BUY1" | python3 -c "import sys,json; print(json.load(sys.stdin)['order']['status'])")
check "Order within limit accepted" "$([[ "$BUY1_STATUS" == "FILLED" ]] && echo true || echo false)" "status=$BUY1_STATUS"

echo "=== 8. Place order exceeding daily notional (projected ~250 > 200) ==="
OVER_HTTP=$(curl -s -o /tmp/gov-over-resp.json -w "%{http_code}" -X POST "$BASE/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"side\":\"BUY\",\"type\":\"MARKET\",\"qty\":\"0.004\"}")
OVER_CODE=$(python3 -c "import sys,json; d=json.load(open('/tmp/gov-over-resp.json')); print(d.get('details',{}).get('code', d.get('code','')))" 2>/dev/null || echo "")
check "Notional over-limit rejected 403" "$([[ "$OVER_HTTP" == "403" ]] && echo true || echo false)" "http=$OVER_HTTP"
check "Error code is DAILY_NOTIONAL_LIMIT_EXCEEDED" "$([[ "$OVER_CODE" == "DAILY_NOTIONAL_LIMIT_EXCEEDED" ]] && echo true || echo false)" "code=$OVER_CODE"

echo "=== 9. Suspend account ==="
SUSPEND=$(curl -sf -X PATCH "$BASE/v1/admin/account-status" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$TRADER_ID\",\"status\":\"SUSPENDED\"}")
SUSP_STATUS=$(echo "$SUSPEND" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('accountStatus',''))")
check "Account suspended" "$([[ "$SUSP_STATUS" == "SUSPENDED" ]] && echo true || echo false)" "status=$SUSP_STATUS"

echo "=== 10. Suspended account order blocked ==="
SUSP_HTTP=$(curl -s -o /tmp/gov-susp-resp.json -w "%{http_code}" -X POST "$BASE/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"side\":\"BUY\",\"type\":\"MARKET\",\"qty\":\"0.0001\"}")
SUSP_CODE=$(python3 -c "import sys,json; d=json.load(open('/tmp/gov-susp-resp.json')); print(d.get('details',{}).get('code', d.get('code','')))" 2>/dev/null || echo "")
check "Suspended account rejected 403" "$([[ "$SUSP_HTTP" == "403" ]] && echo true || echo false)" "http=$SUSP_HTTP"
check "Error code is ACCOUNT_SUSPENDED" "$([[ "$SUSP_CODE" == "ACCOUNT_SUSPENDED" ]] && echo true || echo false)" "code=$SUSP_CODE"

echo "=== 11. Re-activate account ==="
ACTIVATE=$(curl -sf -X PATCH "$BASE/v1/admin/account-status" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$TRADER_ID\",\"status\":\"ACTIVE\"}")
ACT_STATUS=$(echo "$ACTIVATE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('accountStatus',''))")
check "Account re-activated" "$([[ "$ACT_STATUS" == "ACTIVE" ]] && echo true || echo false)" "status=$ACT_STATUS"

echo "=== 12. Re-activated account can trade (small order within remaining limit) ==="
BUY3=$(curl -sf -X POST "$BASE/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"side\":\"BUY\",\"type\":\"MARKET\",\"qty\":\"0.001\"}")
BUY3_STATUS=$(echo "$BUY3" | python3 -c "import sys,json; print(json.load(sys.stdin)['order']['status'])")
check "Re-activated order accepted" "$([[ "$BUY3_STATUS" == "FILLED" ]] && echo true || echo false)" "status=$BUY3_STATUS"

rm -f "$COOKIES" "$ADMIN_COOKIES" /tmp/gov-over-resp.json /tmp/gov-susp-resp.json

echo ""
echo "═══════════════════════════════"
echo "  PASS: $PASS_COUNT  FAIL: $FAIL_COUNT"
echo "═══════════════════════════════"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
echo "All governance smoke tests passed."
