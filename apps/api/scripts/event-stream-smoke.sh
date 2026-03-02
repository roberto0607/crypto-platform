#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:3001"
EMAIL="evstream-smoke-$(date +%s)@example.com"
ADMIN_EMAIL="evstream-admin-$(date +%s)@example.com"
PASS="SmokeTest1234"
COOKIES="/tmp/evstream-smoke-cookies.txt"
ADMIN_COOKIES="/tmp/evstream-smoke-admin-cookies.txt"
PASS_COUNT=0
FAIL_COUNT=0

rm -f "$COOKIES" "$ADMIN_COOKIES"

# Clear circuit breakers that may block order placement from prior test runs
docker exec cp_postgres psql -U cp -d cp -c \
  "DELETE FROM circuit_breakers WHERE breaker_key = 'RECONCILIATION_CRITICAL';" > /dev/null 2>&1

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

echo "=== 1. Verify chain starts empty ==="
# Truncate any leftover events from prior runs (bypass trigger)
docker exec cp_postgres psql -U cp -d cp -c \
  "SET session_replication_role = 'replica'; DELETE FROM event_stream; SET session_replication_role = 'origin';" > /dev/null 2>&1

echo "=== 2. Register admin + trader ==="
curl -sf -X POST "$BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PASS\"}" || true

curl -sf -X POST "$BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" || true
echo " OK"

echo "=== 3. Login admin ==="
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

echo "=== 4. Login trader ==="
TRADER_LOGIN=$(curl -sf -c "$COOKIES" -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
TOKEN=$(echo "$TRADER_LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
TRADER_ID=$(echo "$TRADER_LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['user']['id'])")
echo " OK"

echo "=== 5. Verify chain empty ==="
VERIFY0=$(curl -sf -X POST "$BASE/v1/admin/event-stream/verify" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
V0_VALID=$(echo "$VERIFY0" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['valid'])")
V0_TOTAL=$(echo "$VERIFY0" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['totalEvents'])")
check "Empty chain is valid" "$([[ "$V0_VALID" == "True" ]] && echo true || echo false)" "valid=$V0_VALID"
check "Empty chain has 0 events" "$([[ "$V0_TOTAL" == "0" ]] && echo true || echo false)" "total=$V0_TOTAL"

echo "=== 6. Setup assets + pair + wallets ==="
SHORT=$(date +%s | cut -c 6-)
BASE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"EB$SHORT\",\"name\":\"EvStream BTC\",\"decimals\":8}")
BASE_ASSET_ID=$(echo "$BASE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

QUOTE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"EQ$SHORT\",\"name\":\"EvStream USD\",\"decimals\":2}")
QUOTE_ASSET_ID=$(echo "$QUOTE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

PAIR=$(curl -sf -X POST "$BASE/admin/pairs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"baseAssetId\":\"$BASE_ASSET_ID\",\"quoteAssetId\":\"$QUOTE_ASSET_ID\",\"symbol\":\"EP$SHORT\",\"feeBps\":10}")
PAIR_ID=$(echo "$PAIR" | python3 -c "import sys,json; print(json.load(sys.stdin)['pair']['id'])")

curl -sf -X PATCH "$BASE/admin/pairs/$PAIR_ID/price" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"price\":\"50000\"}" > /dev/null

curl -sf -X POST "$BASE/wallets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"assetId\":\"$BASE_ASSET_ID\"}" > /dev/null

QW=$(curl -sf -X POST "$BASE/wallets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"assetId\":\"$QUOTE_ASSET_ID\"}")
QW_ID=$(echo "$QW" | python3 -c "import sys,json; print(json.load(sys.stdin)['wallet']['id'])")

curl -sf -X POST "$BASE/admin/wallets/$QW_ID/credit" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"amount\":\"500000\"}" > /dev/null
echo " OK"

echo "=== 7. Place order (generates ORDER_PLACED + TRADE_EXECUTED events) ==="
ORDER=$(curl -sf -X POST "$BASE/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"side\":\"BUY\",\"type\":\"MARKET\",\"qty\":\"0.5\"}")
ORDER_STATUS=$(echo "$ORDER" | python3 -c "import sys,json; print(json.load(sys.stdin)['order']['status'])")
check "Order filled" "$([[ "$ORDER_STATUS" == "FILLED" ]] && echo true || echo false)" "status=$ORDER_STATUS"

# Wait for fire-and-forget events to be recorded
sleep 2

echo "=== 8. List events -> ORDER_PLACED + TRADE_EXECUTED ==="
EVENTS=$(curl -sf "$BASE/v1/admin/event-stream?limit=10" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
EVENT_COUNT=$(echo "$EVENTS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']))")
HAS_ORDER=$(echo "$EVENTS" | python3 -c "
import sys,json
data = json.load(sys.stdin)['data']
print('true' if any(e['event_type'] == 'ORDER_PLACED' for e in data) else 'false')
")
HAS_TRADE=$(echo "$EVENTS" | python3 -c "
import sys,json
data = json.load(sys.stdin)['data']
print('true' if any(e['event_type'] == 'TRADE_EXECUTED' for e in data) else 'false')
")
FIRST_PREV=$(echo "$EVENTS" | python3 -c "import sys,json; print(json.load(sys.stdin)['data'][0]['previous_event_hash'])")
check "Events recorded" "$([[ "$EVENT_COUNT" -ge 2 ]] && echo true || echo false)" "count=$EVENT_COUNT"
check "ORDER_PLACED event exists" "$HAS_ORDER"
check "TRADE_EXECUTED event exists" "$HAS_TRADE"
check "First event uses GENESIS" "$([[ "$FIRST_PREV" == "GENESIS" ]] && echo true || echo false)" "prev=$FIRST_PREV"

echo "=== 9. Verify chain valid ==="
VERIFY1=$(curl -sf -X POST "$BASE/v1/admin/event-stream/verify" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
V1_VALID=$(echo "$VERIFY1" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['valid'])")
V1_TOTAL=$(echo "$VERIFY1" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['totalEvents'])")
check "Chain valid after orders" "$([[ "$V1_VALID" == "True" ]] && echo true || echo false)" "valid=$V1_VALID total=$V1_TOTAL"

echo "=== 10. GET single event ==="
FIRST_ID=$(echo "$EVENTS" | python3 -c "import sys,json; print(json.load(sys.stdin)['data'][0]['id'])")
SINGLE=$(curl -sf "$BASE/v1/admin/event-stream/$FIRST_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
SINGLE_ID=$(echo "$SINGLE" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
check "Single event returned" "$([[ "$SINGLE_ID" == "$FIRST_ID" ]] && echo true || echo false)"

echo "=== 11. Tamper detection ==="
docker exec cp_postgres psql -U cp -d cp -c \
  "SET session_replication_role = 'replica'; UPDATE event_stream SET payload = '{\"tampered\":true}' WHERE id = $FIRST_ID; SET session_replication_role = 'origin';" > /dev/null

VERIFY2=$(curl -sf -X POST "$BASE/v1/admin/event-stream/verify" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
V2_VALID=$(echo "$VERIFY2" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['valid'])")
V2_INVALID_ID=$(echo "$VERIFY2" | python3 -c "import sys,json; print(json.load(sys.stdin)['data'].get('firstInvalidId',''))")
check "Chain invalid after tamper" "$([[ "$V2_VALID" == "False" ]] && echo true || echo false)" "valid=$V2_VALID firstInvalidId=$V2_INVALID_ID"

# Cleanup
rm -f "$COOKIES" "$ADMIN_COOKIES"

echo ""
echo "═══════════════════════════════"
echo "  PASS: $PASS_COUNT  FAIL: $FAIL_COUNT"
echo "═══════════════════════════════"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
echo "All event stream smoke tests passed."
