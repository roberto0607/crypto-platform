#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:3001"
EMAIL="v1smoke-$(date +%s)@example.com"
PASS="SmokeTest1234"
COOKIES="/tmp/v1-smoke-cookies.txt"
ADMIN_EMAIL="v1admin-$(date +%s)@example.com"
ADMIN_COOKIES="/tmp/v1-smoke-admin-cookies.txt"

rm -f "$COOKIES" "$ADMIN_COOKIES"

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

# Promote to admin via DB
PGPASSWORD=cp psql -h localhost -p 5433 -U cp -d cp -c \
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
UID_TAG=$(date +%s)
BASE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"S$UID_TAG\",\"name\":\"Smoke BTC\",\"decimals\":8}")
BASE_ASSET_ID=$(echo "$BASE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

QUOTE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"Q$UID_TAG\",\"name\":\"Smoke USD\",\"decimals\":2}")
QUOTE_ASSET_ID=$(echo "$QUOTE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

PAIR=$(curl -sf -X POST "$BASE/admin/pairs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"baseAssetId\":\"$BASE_ASSET_ID\",\"quoteAssetId\":\"$QUOTE_ASSET_ID\",\"symbol\":\"P$UID_TAG\",\"feeBps\":0}")
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

echo "=== 6. Place 3 orders ==="
for i in 1 2 3; do
  PRICE=$((49000 + i))
  curl -sf -X POST "$BASE/orders" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"pairId\":\"$PAIR_ID\",\"side\":\"BUY\",\"type\":\"LIMIT\",\"qty\":\"0.1\",\"limitPrice\":\"$PRICE\"}" > /dev/null
done
echo " OK"

echo "=== 7. GET /v1/orders?limit=2 (page 1) ==="
PAGE1=$(curl -sf "$BASE/v1/orders?limit=2" \
  -H "Authorization: Bearer $TOKEN")
echo "$PAGE1" | python3 -m json.tool

COUNT1=$(echo "$PAGE1" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']))")
CURSOR=$(echo "$PAGE1" | python3 -c "import sys,json; print(json.load(sys.stdin)['nextCursor'])")

if [ "$COUNT1" != "2" ]; then
  echo "FAIL: expected 2 items on page 1, got $COUNT1"; exit 1
fi
if [ "$CURSOR" = "None" ] || [ "$CURSOR" = "null" ]; then
  echo "FAIL: expected nextCursor on page 1"; exit 1
fi
echo "PASS: page 1 has 2 items + nextCursor"

echo "=== 8. GET /v1/orders?limit=2&cursor=... (page 2) ==="
PAGE2=$(curl -sf "$BASE/v1/orders?limit=2&cursor=$CURSOR" \
  -H "Authorization: Bearer $TOKEN")
echo "$PAGE2" | python3 -m json.tool

COUNT2=$(echo "$PAGE2" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']))")
CURSOR2=$(echo "$PAGE2" | python3 -c "import sys,json; d=json.load(sys.stdin)['nextCursor']; print(d if d else 'null')")

if [ "$COUNT2" != "1" ]; then
  echo "FAIL: expected 1 item on page 2, got $COUNT2"; exit 1
fi
if [ "$CURSOR2" != "null" ]; then
  echo "FAIL: expected null nextCursor on page 2"; exit 1
fi
echo "PASS: page 2 has 1 item + null nextCursor"

echo "=== 9. GET /v1/pairs ==="
PAIRS=$(curl -sf "$BASE/v1/pairs" \
  -H "Authorization: Bearer $TOKEN")
echo "$PAIRS" | python3 -m json.tool
PAIRS_COUNT=$(echo "$PAIRS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']))")
if [ "$PAIRS_COUNT" -lt 1 ]; then
  echo "FAIL: expected at least 1 pair"; exit 1
fi
echo "PASS: /v1/pairs returned $PAIRS_COUNT pair(s)"

rm -f "$COOKIES" "$ADMIN_COOKIES"
echo ""
echo "All v1 smoke tests passed."
