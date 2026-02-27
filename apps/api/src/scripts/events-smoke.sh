#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:3001"
EMAIL="sse-smoke-$(date +%s)@example.com"
PASS="SmokeTest1234"
ADMIN_EMAIL="sseadmin-$(date +%s)@example.com"
SSE_OUTPUT="/tmp/sse-smoke-output.txt"
COOKIES="/tmp/sse-smoke-cookies.txt"
ADMIN_COOKIES="/tmp/sse-smoke-admin-cookies.txt"

rm -f "$SSE_OUTPUT" "$COOKIES" "$ADMIN_COOKIES"

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

# Promote to admin via DB (using docker exec since psql may not be on host)
docker exec cp_postgres psql -U cp -d cp -c \
  "UPDATE users SET role = 'ADMIN' WHERE id = '$ADMIN_ID';" > /dev/null

# Re-login for admin token
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
UID_TAG=$(date +%s | tail -c 7)
BASE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"EB$UID_TAG\",\"name\":\"SSE BTC\",\"decimals\":8}")
BASE_ASSET_ID=$(echo "$BASE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

QUOTE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"EQ$UID_TAG\",\"name\":\"SSE USD\",\"decimals\":2}")
QUOTE_ASSET_ID=$(echo "$QUOTE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

PAIR=$(curl -sf -X POST "$BASE/admin/pairs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"baseAssetId\":\"$BASE_ASSET_ID\",\"quoteAssetId\":\"$QUOTE_ASSET_ID\",\"symbol\":\"EP$UID_TAG\",\"feeBps\":0}")
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
echo " OK"

echo "=== 6. Start SSE stream in background ==="
curl -sN "$BASE/v1/events" \
  -H "Authorization: Bearer $TOKEN" \
  > "$SSE_OUTPUT" 2>&1 &
SSE_PID=$!

# Give the SSE connection time to establish
sleep 1

echo "=== 7. Place LIMIT BUY order ==="
ORDER_RESP=$(curl -sf -X POST "$BASE/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"side\":\"BUY\",\"type\":\"LIMIT\",\"qty\":\"0.01\",\"limitPrice\":\"49000\"}")
echo "$ORDER_RESP" | python3 -m json.tool
echo " OK"

# Wait for events to stream
sleep 2

echo "=== 8. Check SSE output ==="
kill "$SSE_PID" 2>/dev/null || true
sleep 0.5

echo "--- SSE output ---"
cat "$SSE_OUTPUT"
echo "--- end ---"

# Verify events received
if grep -q "order.updated" "$SSE_OUTPUT"; then
  echo "PASS: order.updated event received"
else
  echo "FAIL: order.updated event NOT received"
  rm -f "$SSE_OUTPUT" "$COOKIES" "$ADMIN_COOKIES"
  exit 1
fi

rm -f "$SSE_OUTPUT" "$COOKIES" "$ADMIN_COOKIES"
echo ""
echo "All SSE smoke tests passed."
