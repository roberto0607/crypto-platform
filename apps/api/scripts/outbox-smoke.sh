#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:3001"
EMAIL="outbox-smoke-$(date +%s)@example.com"
ADMIN_EMAIL="outbox-admin-$(date +%s)@example.com"
PASS="SmokeTest1234"
COOKIES="/tmp/outbox-smoke-cookies.txt"
ADMIN_COOKIES="/tmp/outbox-smoke-admin-cookies.txt"
PASS_COUNT=0
FAIL_COUNT=0

rm -f "$COOKIES" "$ADMIN_COOKIES"

# Clear circuit breakers that may block order placement from prior test runs
docker exec cp_postgres psql -U cp -d cp -c \
  "DELETE FROM circuit_breakers WHERE breaker_key = 'RECONCILIATION_CRITICAL';" > /dev/null 2>&1

# Clear tampered event_stream rows from prior test runs
docker exec cp_postgres psql -U cp -d cp -c \
  "SET session_replication_role = 'replica'; DELETE FROM event_stream; SET session_replication_role = 'origin';" > /dev/null 2>&1

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

echo "═══════════════════════════════════════"
echo "  Outbox Smoke Tests"
echo "═══════════════════════════════════════"
echo ""

echo "=== 1. Register admin + trader ==="
curl -sf -X POST "$BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PASS\"}" > /dev/null || true

sleep 1

curl -sf -X POST "$BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" > /dev/null || true
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
echo " OK"

echo "=== 4. Get baseline outbox stats ==="
STATS0=$(curl -sf "$BASE/v1/admin/outbox/stats" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
BASELINE_DONE=$(echo "$STATS0" | python3 -c "import sys,json; print(json.load(sys.stdin)['data'].get('DONE',0))")
BASELINE_PENDING=$(echo "$STATS0" | python3 -c "import sys,json; print(json.load(sys.stdin)['data'].get('PENDING',0))")
echo "  Baseline: DONE=$BASELINE_DONE PENDING=$BASELINE_PENDING"
check "Stats endpoint reachable" "true"

echo "=== 5. Setup assets + pair + wallets ==="
SHORT=$(date +%s | cut -c 6-)
BASE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"OB$SHORT\",\"name\":\"Outbox BTC\",\"decimals\":8}")
BASE_ASSET_ID=$(echo "$BASE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

QUOTE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"OQ$SHORT\",\"name\":\"Outbox USD\",\"decimals\":2}")
QUOTE_ASSET_ID=$(echo "$QUOTE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

PAIR=$(curl -sf -X POST "$BASE/admin/pairs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"baseAssetId\":\"$BASE_ASSET_ID\",\"quoteAssetId\":\"$QUOTE_ASSET_ID\",\"symbol\":\"OP$SHORT\",\"feeBps\":10}")
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

echo "=== 6. Place order (generates outbox rows) ==="
ORDER=$(curl -sf -X POST "$BASE/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"side\":\"BUY\",\"type\":\"MARKET\",\"qty\":\"0.5\"}")
ORDER_STATUS=$(echo "$ORDER" | python3 -c "import sys,json; print(json.load(sys.stdin)['order']['status'])")
check "Order filled" "$([[ "$ORDER_STATUS" == "FILLED" ]] && echo true || echo false)" "status=$ORDER_STATUS"

echo "=== 7. Verify outbox rows created ==="
# Check outbox immediately (before worker processes them)
OUTBOX_LIST=$(curl -sf "$BASE/v1/admin/outbox?limit=200" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
HAS_ORDER_PLACED=$(echo "$OUTBOX_LIST" | python3 -c "
import sys,json
data = json.load(sys.stdin)['data']
print('true' if any(
  e['event_type'] == 'EVENT_STREAM_APPEND'
  and e.get('payload',{}).get('eventInput',{}).get('eventType') == 'ORDER_PLACED'
  for e in data
) else 'false')
")
HAS_TRADE_EXEC=$(echo "$OUTBOX_LIST" | python3 -c "
import sys,json
data = json.load(sys.stdin)['data']
print('true' if any(
  e['event_type'] == 'EVENT_STREAM_APPEND'
  and e.get('payload',{}).get('eventInput',{}).get('eventType') == 'TRADE_EXECUTED'
  for e in data
) else 'false')
")
check "Outbox has ORDER_PLACED event" "$HAS_ORDER_PLACED"
check "Outbox has TRADE_EXECUTED event" "$HAS_TRADE_EXEC"

echo "=== 8. Wait for worker to process + verify DONE ==="
sleep 3

STATS1=$(curl -sf "$BASE/v1/admin/outbox/stats" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
DONE_COUNT=$(echo "$STATS1" | python3 -c "import sys,json; print(json.load(sys.stdin)['data'].get('DONE',0))")
NEW_DONE=$((DONE_COUNT - BASELINE_DONE))
check "Worker processed events" "$([[ "$NEW_DONE" -ge 2 ]] && echo true || echo false)" "new_done=$NEW_DONE"

echo "=== 9. Verify event_stream updated by worker ==="
EVENTS=$(curl -sf "$BASE/v1/admin/event-stream?limit=50" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
ES_ORDER=$(echo "$EVENTS" | python3 -c "
import sys,json
data = json.load(sys.stdin)['data']
print('true' if any(e['event_type'] == 'ORDER_PLACED' for e in data) else 'false')
")
ES_TRADE=$(echo "$EVENTS" | python3 -c "
import sys,json
data = json.load(sys.stdin)['data']
print('true' if any(e['event_type'] == 'TRADE_EXECUTED' for e in data) else 'false')
")
check "Event stream has ORDER_PLACED" "$ES_ORDER"
check "Event stream has TRADE_EXECUTED" "$ES_TRADE"

echo "=== 10. Admin list endpoint with status filter ==="
DONE_LIST=$(curl -sf "$BASE/v1/admin/outbox?status=DONE&limit=5" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
DONE_LIST_COUNT=$(echo "$DONE_LIST" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']))")
check "Admin list DONE filter works" "$([[ "$DONE_LIST_COUNT" -ge 1 ]] && echo true || echo false)" "count=$DONE_LIST_COUNT"

echo "=== 11. Admin replay endpoint ==="
REPLAY=$(curl -sf -X POST "$BASE/v1/admin/outbox/replay" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
REPLAY_PROCESSED=$(echo "$REPLAY" | python3 -c "import sys,json; print(json.load(sys.stdin)['processed'])")
check "Replay endpoint returns processed count" "$([[ "$REPLAY_PROCESSED" -ge 0 ]] && echo true || echo false)" "processed=$REPLAY_PROCESSED"

echo "=== 12. Admin retry endpoint (inject FAILED row + reset) ==="
# Insert a dummy FAILED outbox event directly
FAILED_ID=$(docker exec cp_postgres psql -U cp -d cp -t -A -c \
  "INSERT INTO outbox_events (event_type, aggregate_type, payload, status, attempts, last_error)
   VALUES ('EVENT_STREAM_APPEND', 'ORDER', '{\"eventInput\":{\"eventType\":\"TEST_RETRY\",\"entityType\":\"ORDER\",\"payload\":{\"test\":true}}}', 'FAILED', 3, 'test error')
   RETURNING id;" | head -1)
FAILED_ID=$(echo "$FAILED_ID" | tr -d '[:space:]')

RETRY=$(curl -sf -X POST "$BASE/v1/admin/outbox/retry/$FAILED_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
RETRY_OK=$(echo "$RETRY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))")
check "Retry resets FAILED to PENDING" "$([[ "$RETRY_OK" == "True" ]] && echo true || echo false)"

# Verify status changed (PENDING or DONE — worker may process before we check)
RESET_STATUS=$(docker exec cp_postgres psql -U cp -d cp -t -A -c \
  "SELECT status FROM outbox_events WHERE id = $FAILED_ID;" | head -1)
RESET_STATUS=$(echo "$RESET_STATUS" | tr -d '[:space:]')
check "Row no longer FAILED" "$([[ "$RESET_STATUS" == "PENDING" || "$RESET_STATUS" == "DONE" ]] && echo true || echo false)" "status=$RESET_STATUS"

# Cleanup test row
docker exec cp_postgres psql -U cp -d cp -c \
  "DELETE FROM outbox_events WHERE id = $FAILED_ID;" > /dev/null 2>&1

echo "=== 13. Verify chain integrity still valid ==="
VERIFY=$(curl -sf -X POST "$BASE/v1/admin/event-stream/verify" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
V_VALID=$(echo "$VERIFY" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['valid'])")
check "Event stream chain still valid" "$([[ "$V_VALID" == "True" ]] && echo true || echo false)"

# Cleanup
rm -f "$COOKIES" "$ADMIN_COOKIES"

echo ""
echo "═══════════════════════════════════════"
echo "  PASS: $PASS_COUNT  FAIL: $FAIL_COUNT"
echo "═══════════════════════════════════════"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
echo "All outbox smoke tests passed."
