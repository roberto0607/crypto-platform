#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:3001"
EMAIL="sim-smoke-$(date +%s)@example.com"
ADMIN_EMAIL="sim-admin-$(date +%s)@example.com"
PASS="SmokeTest1234"
COOKIES="/tmp/sim-smoke-cookies.txt"
ADMIN_COOKIES="/tmp/sim-smoke-admin-cookies.txt"
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
ADMIN_TOKEN=$(echo "$ADMIN_LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
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
echo " OK"

echo "=== 4. Create assets + pair ==="
SHORT=$(date +%s | cut -c 6-)
BASE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"SB$SHORT\",\"name\":\"Sim BTC\",\"decimals\":8}")
BASE_ASSET_ID=$(echo "$BASE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

QUOTE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"SQ$SHORT\",\"name\":\"Sim USD\",\"decimals\":2}")
QUOTE_ASSET_ID=$(echo "$QUOTE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

PAIR=$(curl -sf -X POST "$BASE/admin/pairs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"baseAssetId\":\"$BASE_ASSET_ID\",\"quoteAssetId\":\"$QUOTE_ASSET_ID\",\"symbol\":\"SP$SHORT\",\"feeBps\":5}")
PAIR_ID=$(echo "$PAIR" | python3 -c "import sys,json; print(json.load(sys.stdin)['pair']['id'])")

curl -sf -X PATCH "$BASE/admin/pairs/$PAIR_ID/price" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"price\":\"50000\"}" > /dev/null
echo " OK"

echo "=== 5. Insert candle + start replay ==="
CANDLE_TS="2024-01-01T00:00:00Z"
docker exec cp_postgres psql -U cp -d cp -c \
  "INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
   VALUES ('${PAIR_ID}', '1m', '${CANDLE_TS}', 50000, 50500, 49500, 50200, 100)
   ON CONFLICT DO NOTHING" > /dev/null 2>&1

START_REPLAY=$(curl -sf -X POST "$BASE/replay/start" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"startTs\":\"$CANDLE_TS\",\"timeframe\":\"1m\",\"speed\":1}")
IS_ACTIVE=$(echo "$START_REPLAY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session',{}).get('is_active', False))")
check "Replay session active" "$([[ "$IS_ACTIVE" == "True" ]] && echo true || echo false)"
echo " OK"

echo "=== 6. Create wallets + credit ==="
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
echo " OK"

echo "=== 7. GET /v1/sim/config ==="
SIM_CFG=$(curl -sf "$BASE/v1/sim/config?pairId=$PAIR_ID" \
  -H "Authorization: Bearer $TOKEN")
HAS_SPREAD=$(echo "$SIM_CFG" | python3 -c "import sys,json; d=json.load(sys.stdin); print('base_spread_bps' in d)")
check "GET /v1/sim/config returns config" "$([[ "$HAS_SPREAD" == "True" ]] && echo true || echo false)"

echo "=== 8. Small MARKET BUY → succeeds ==="
BUY=$(curl -sf -X POST "$BASE/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"side\":\"BUY\",\"type\":\"MARKET\",\"qty\":\"0.001\"}")
BUY_STATUS=$(echo "$BUY" | python3 -c "import sys,json; print(json.load(sys.stdin)['order']['status'])")
BUY_FILLS=$(echo "$BUY" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['fills']))")
check "Small MARKET BUY filled" "$([[ "$BUY_STATUS" == "FILLED" ]] && echo true || echo false)" "status=$BUY_STATUS fills=$BUY_FILLS"

echo "=== 9. Over-liquidity MARKET BUY → rejected (insufficient_liquidity) ==="
# qty=1.5 → notional=75000 (within 100K risk limit, but > 50K liquidity cap)
LARGE_HTTP=$(curl -s -o /tmp/sim-large-resp.json -w "%{http_code}" -X POST "$BASE/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"side\":\"BUY\",\"type\":\"MARKET\",\"qty\":\"1.5\"}")
LARGE_CODE=$(cat /tmp/sim-large-resp.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error', d.get('code','')))" 2>/dev/null || echo "")
check "Over-liquidity MARKET BUY rejected 400" "$([[ "$LARGE_HTTP" == "400" ]] && echo true || echo false)" "http=$LARGE_HTTP code=$LARGE_CODE"
check "Error code is insufficient_liquidity" "$([[ "$LARGE_CODE" == "insufficient_liquidity" ]] && echo true || echo false)"

echo "=== 10. Verify no order row for rejected case ==="
ORDER_COUNT_BEFORE=$(docker exec cp_postgres psql -U cp -d cp -t -c \
  "SELECT count(*) FROM orders WHERE pair_id = '$PAIR_ID';" | tr -d ' ')
# Should be 1 (the small BUY only)
check "Only 1 order row exists (rejected not persisted)" "$([[ "$ORDER_COUNT_BEFORE" == "1" ]] && echo true || echo false)" "count=$ORDER_COUNT_BEFORE"

echo "=== 11. GET /v1/sim/quote (small, executable) ==="
QUOTE_SMALL=$(curl -sf "$BASE/v1/sim/quote?pairId=$PAIR_ID&side=BUY&qty=0.001" \
  -H "Authorization: Bearer $TOKEN")
EXEC=$(echo "$QUOTE_SMALL" | python3 -c "import sys,json; print(json.load(sys.stdin)['executable'])")
check "Small sim quote executable" "$([[ "$EXEC" == "True" ]] && echo true || echo false)"

echo "=== 12. GET /v1/sim/quote (large, not executable) ==="
QUOTE_LARGE=$(curl -sf "$BASE/v1/sim/quote?pairId=$PAIR_ID&side=BUY&qty=99999" \
  -H "Authorization: Bearer $TOKEN")
NOT_EXEC=$(echo "$QUOTE_LARGE" | python3 -c "import sys,json; print(json.load(sys.stdin)['executable'])")
check "Large sim quote not executable" "$([[ "$NOT_EXEC" == "False" ]] && echo true || echo false)"

echo "=== 13. LIMIT order (any qty, no slippage) ==="
# Credit more quote
curl -sf -X POST "$BASE/admin/wallets/$QW_ID/credit" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"amount\":\"1000000\"}" > /dev/null

LIMIT_ORD=$(curl -sf -X POST "$BASE/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"side\":\"BUY\",\"type\":\"LIMIT\",\"qty\":\"5\",\"limitPrice\":\"49000\"}")
LIMIT_STATUS=$(echo "$LIMIT_ORD" | python3 -c "import sys,json; print(json.load(sys.stdin)['order']['status'])")
check "LIMIT order unaffected (OPEN)" "$([[ "$LIMIT_STATUS" == "OPEN" ]] && echo true || echo false)" "status=$LIMIT_STATUS"

rm -f "$COOKIES" "$ADMIN_COOKIES" /tmp/sim-large-resp.json

echo ""
echo "═══════════════════════════════"
echo "  PASS: $PASS_COUNT  FAIL: $FAIL_COUNT"
echo "═══════════════════════════════"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
echo "All sim smoke tests passed."
