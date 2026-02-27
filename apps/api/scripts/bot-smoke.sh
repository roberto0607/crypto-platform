#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:3001"
EMAIL="botsmoke-$(date +%s)@example.com"
PASS="SmokeTest1234"
COOKIES="/tmp/bot-smoke-cookies.txt"
ADMIN_EMAIL="botadmin-$(date +%s)@example.com"
ADMIN_COOKIES="/tmp/bot-smoke-admin-cookies.txt"
PASS_COUNT=0
FAIL_COUNT=0

rm -f "$COOKIES" "$ADMIN_COOKIES"

pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

echo "=== 1. Register admin + trader ==="
curl -sf -X POST "$BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PASS\"}" > /dev/null || true

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
TRADER_ID=$(echo "$TRADER_LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['user']['id'])")
echo " OK"

echo "=== 4. Create assets + pair ==="
UID_TAG=$(date +%s | tail -c 7)
BASE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"BB$UID_TAG\",\"name\":\"Bot BTC\",\"decimals\":8}")
BASE_ASSET_ID=$(echo "$BASE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

QUOTE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"BU$UID_TAG\",\"name\":\"Bot USD\",\"decimals\":2}")
QUOTE_ASSET_ID=$(echo "$QUOTE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

PAIR=$(curl -sf -X POST "$BASE/admin/pairs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"baseAssetId\":\"$BASE_ASSET_ID\",\"quoteAssetId\":\"$QUOTE_ASSET_ID\",\"symbol\":\"BP$UID_TAG\",\"feeBps\":0}")
PAIR_ID=$(echo "$PAIR" | python3 -c "import sys,json; print(json.load(sys.stdin)['pair']['id'])")

curl -sf -X PATCH "$BASE/admin/pairs/$PAIR_ID/price" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"price\":\"50000\"}" > /dev/null
echo " OK"

echo "=== 5. Create wallets + credit ==="
BW=$(curl -sf -X POST "$BASE/wallets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"assetId\":\"$BASE_ASSET_ID\"}")
BW_ID=$(echo "$BW" | python3 -c "import sys,json; print(json.load(sys.stdin)['wallet']['id'])")

QW=$(curl -sf -X POST "$BASE/wallets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"assetId\":\"$QUOTE_ASSET_ID\"}")
QW_ID=$(echo "$QW" | python3 -c "import sys,json; print(json.load(sys.stdin)['wallet']['id'])")

curl -sf -X POST "$BASE/admin/wallets/$QW_ID/credit" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"amount\":\"1000000\"}" > /dev/null

curl -sf -X POST "$BASE/admin/wallets/$BW_ID/credit" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"amount\":\"10\"}" > /dev/null
echo " OK"

echo "=== 6. Start replay session ==="
START_TS="2025-01-01T00:00:00Z"
REPLAY=$(curl -sf -X POST "$BASE/replay/start" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"startTs\":\"$START_TS\",\"timeframe\":\"15m\",\"speed\":1}")
REPLAY_OK=$(echo "$REPLAY" | python3 -c "import sys,json; print(json.load(sys.stdin)['ok'])")

if [ "$REPLAY_OK" = "True" ]; then
  pass "replay session started"
else
  fail "replay session start failed"
fi

echo "=== 7. POST /v1/bot/runs — start bot run ==="
RUN=$(curl -sf -X POST "$BASE/v1/bot/runs" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"mode\":\"REPLAY\"}")
RUN_ID=$(echo "$RUN" | python3 -c "import sys,json; print(json.load(sys.stdin)['run']['id'])")
RUN_STATUS=$(echo "$RUN" | python3 -c "import sys,json; print(json.load(sys.stdin)['run']['status'])")

if [ "$RUN_STATUS" = "RUNNING" ]; then
  pass "bot run started with RUNNING status"
else
  fail "expected RUNNING, got $RUN_STATUS"
fi

echo "=== 8. GET /v1/bot/runs/:id — get run ==="
GET_RUN=$(curl -sf "$BASE/v1/bot/runs/$RUN_ID" \
  -H "Authorization: Bearer $TOKEN")
GET_RUN_STATUS=$(echo "$GET_RUN" | python3 -c "import sys,json; print(json.load(sys.stdin)['run']['status'])")

if [ "$GET_RUN_STATUS" = "RUNNING" ]; then
  pass "GET run returns RUNNING"
else
  fail "expected RUNNING, got $GET_RUN_STATUS"
fi

echo "=== 9. POST /v1/bot/runs/:id/pause ==="
PAUSE=$(curl -sf -X POST "$BASE/v1/bot/runs/$RUN_ID/pause" \
  -H "Authorization: Bearer $TOKEN")
PAUSE_STATUS=$(echo "$PAUSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['run']['status'])")

if [ "$PAUSE_STATUS" = "PAUSED" ]; then
  pass "bot run paused"
else
  fail "expected PAUSED, got $PAUSE_STATUS"
fi

echo "=== 10. POST /v1/bot/runs/:id/resume ==="
RESUME=$(curl -sf -X POST "$BASE/v1/bot/runs/$RUN_ID/resume" \
  -H "Authorization: Bearer $TOKEN")
RESUME_STATUS=$(echo "$RESUME" | python3 -c "import sys,json; print(json.load(sys.stdin)['run']['status'])")

if [ "$RESUME_STATUS" = "RUNNING" ]; then
  pass "bot run resumed"
else
  fail "expected RUNNING, got $RESUME_STATUS"
fi

echo "=== 11. POST /v1/bot/runs/:id/stop ==="
STOP=$(curl -sf -X POST "$BASE/v1/bot/runs/$RUN_ID/stop" \
  -H "Authorization: Bearer $TOKEN")
STOP_STATUS=$(echo "$STOP" | python3 -c "import sys,json; print(json.load(sys.stdin)['run']['status'])")

if [ "$STOP_STATUS" = "STOPPED" ]; then
  pass "bot run stopped"
else
  fail "expected STOPPED, got $STOP_STATUS"
fi

echo "=== 12. GET /v1/bot/runs — list runs ==="
LIST=$(curl -sf "$BASE/v1/bot/runs" \
  -H "Authorization: Bearer $TOKEN")
LIST_COUNT=$(echo "$LIST" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']))")

if [ "$LIST_COUNT" -ge 1 ]; then
  pass "GET /v1/bot/runs returns >= 1 run"
else
  fail "expected >= 1 run, got $LIST_COUNT"
fi

echo "=== 13. GET /v1/bot/runs/:id/signals — empty for now ==="
SIGNALS=$(curl -sf "$BASE/v1/bot/runs/$RUN_ID/signals" \
  -H "Authorization: Bearer $TOKEN")
SIG_OK=$(echo "$SIGNALS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['ok'] and isinstance(d['data'], list))")

if [ "$SIG_OK" = "True" ]; then
  pass "GET signals returns ok + data array"
else
  fail "signals endpoint returned unexpected shape"
fi

echo "=== 14. Validation: missing pairId ==="
BAD=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/bot/runs" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"mode\":\"REPLAY\"}")

if [ "$BAD" = "400" ]; then
  pass "missing pairId returns 400"
else
  fail "expected 400, got $BAD"
fi

echo "=== 15. Cannot pause a stopped run ==="
BAD_PAUSE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/bot/runs/$RUN_ID/pause" \
  -H "Authorization: Bearer $TOKEN")

if [ "$BAD_PAUSE" = "400" ]; then
  pass "pause on stopped run returns 400"
else
  fail "expected 400, got $BAD_PAUSE"
fi

echo "=== 16. Unauthenticated access ==="
UNAUTH=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/v1/bot/runs")

if [ "$UNAUTH" = "401" ]; then
  pass "unauthenticated access returns 401"
else
  fail "expected 401, got $UNAUTH"
fi

# ── Cleanup ──
rm -f "$COOKIES" "$ADMIN_COOKIES"

echo ""
echo "================================"
echo "  PASS: $PASS_COUNT"
echo "  FAIL: $FAIL_COUNT"
echo "================================"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
echo "All bot smoke tests passed."
