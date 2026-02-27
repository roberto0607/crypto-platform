#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:3001"
EMAIL="trgsmoke-$(date +%s)@example.com"
PASS="SmokeTest1234"
COOKIES="/tmp/trg-smoke-cookies.txt"
ADMIN_EMAIL="trgadmin-$(date +%s)@example.com"
ADMIN_COOKIES="/tmp/trg-smoke-admin-cookies.txt"
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
  -d "{\"symbol\":\"TB$UID_TAG\",\"name\":\"Trigger BTC\",\"decimals\":8}")
BASE_ASSET_ID=$(echo "$BASE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

QUOTE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"TU$UID_TAG\",\"name\":\"Trigger USD\",\"decimals\":2}")
QUOTE_ASSET_ID=$(echo "$QUOTE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

PAIR=$(curl -sf -X POST "$BASE/admin/pairs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"baseAssetId\":\"$BASE_ASSET_ID\",\"quoteAssetId\":\"$QUOTE_ASSET_ID\",\"symbol\":\"TP$UID_TAG\",\"feeBps\":0}")
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

# Credit both wallets
curl -sf -X POST "$BASE/admin/wallets/$QW_ID/credit" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"amount\":\"1000000\"}" > /dev/null

curl -sf -X POST "$BASE/admin/wallets/$BW_ID/credit" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"amount\":\"10\"}" > /dev/null
echo " OK"

echo "=== 6. POST /v1/triggers — create single STOP_MARKET ==="
TRG1=$(curl -sf -X POST "$BASE/v1/triggers" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"kind\":\"STOP_MARKET\",\"side\":\"SELL\",\"triggerPrice\":\"49000\",\"qty\":\"0.5\"}")
TRG1_ID=$(echo "$TRG1" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
TRG1_STATUS=$(echo "$TRG1" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")

if [ "$TRG1_STATUS" = "ACTIVE" ]; then
  pass "single trigger created with ACTIVE status"
else
  fail "expected ACTIVE status, got $TRG1_STATUS"
fi

echo "=== 7. POST /v1/oco — create OCO pair ==="
OCO=$(curl -sf -X POST "$BASE/v1/oco" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"pairId\":\"$PAIR_ID\",
    \"legA\":{\"kind\":\"STOP_MARKET\",\"side\":\"SELL\",\"triggerPrice\":\"48000\",\"qty\":\"0.1\"},
    \"legB\":{\"kind\":\"TAKE_PROFIT_MARKET\",\"side\":\"SELL\",\"triggerPrice\":\"52000\",\"qty\":\"0.1\"}
  }")
OCO_GROUP=$(echo "$OCO" | python3 -c "import sys,json; print(json.load(sys.stdin)['ocoGroupId'])")
LEGA_ID=$(echo "$OCO" | python3 -c "import sys,json; print(json.load(sys.stdin)['legA']['id'])")
LEGB_ID=$(echo "$OCO" | python3 -c "import sys,json; print(json.load(sys.stdin)['legB']['id'])")
LEGA_OCO=$(echo "$OCO" | python3 -c "import sys,json; print(json.load(sys.stdin)['legA']['oco_group_id'])")
LEGB_OCO=$(echo "$OCO" | python3 -c "import sys,json; print(json.load(sys.stdin)['legB']['oco_group_id'])")

if [ "$LEGA_OCO" = "$OCO_GROUP" ] && [ "$LEGB_OCO" = "$OCO_GROUP" ]; then
  pass "OCO legs share same oco_group_id"
else
  fail "OCO group mismatch: legA=$LEGA_OCO legB=$LEGB_OCO group=$OCO_GROUP"
fi

echo "=== 8. GET /v1/triggers — list all ==="
LIST=$(curl -sf "$BASE/v1/triggers" \
  -H "Authorization: Bearer $TOKEN")
LIST_COUNT=$(echo "$LIST" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']))")

if [ "$LIST_COUNT" = "3" ]; then
  pass "GET /v1/triggers returns 3 triggers"
else
  fail "expected 3 triggers, got $LIST_COUNT"
fi

echo "=== 9. GET /v1/triggers?status=ACTIVE ==="
ACTIVE_LIST=$(curl -sf "$BASE/v1/triggers?status=ACTIVE" \
  -H "Authorization: Bearer $TOKEN")
ACTIVE_COUNT=$(echo "$ACTIVE_LIST" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']))")

if [ "$ACTIVE_COUNT" = "3" ]; then
  pass "filter by ACTIVE returns 3"
else
  fail "expected 3 ACTIVE triggers, got $ACTIVE_COUNT"
fi

echo "=== 10. DELETE /v1/triggers/:id — cancel single trigger ==="
CANCEL=$(curl -sf -X DELETE "$BASE/v1/triggers/$TRG1_ID" \
  -H "Authorization: Bearer $TOKEN")
CANCEL_STATUS=$(echo "$CANCEL" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")

if [ "$CANCEL_STATUS" = "CANCELED" ]; then
  pass "DELETE /v1/triggers/:id returns CANCELED"
else
  fail "expected CANCELED, got $CANCEL_STATUS"
fi

echo "=== 11. DELETE idempotent — cancel same trigger again ==="
CANCEL2=$(curl -sf -X DELETE "$BASE/v1/triggers/$TRG1_ID" \
  -H "Authorization: Bearer $TOKEN")
CANCEL2_STATUS=$(echo "$CANCEL2" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")

if [ "$CANCEL2_STATUS" = "CANCELED" ]; then
  pass "idempotent cancel returns CANCELED"
else
  fail "expected CANCELED on re-cancel, got $CANCEL2_STATUS"
fi

echo "=== 12. GET /v1/triggers?status=ACTIVE — verify 2 remain ==="
ACTIVE2=$(curl -sf "$BASE/v1/triggers?status=ACTIVE" \
  -H "Authorization: Bearer $TOKEN")
ACTIVE2_COUNT=$(echo "$ACTIVE2" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']))")

if [ "$ACTIVE2_COUNT" = "2" ]; then
  pass "2 ACTIVE triggers remain after cancel"
else
  fail "expected 2 ACTIVE, got $ACTIVE2_COUNT"
fi

echo "=== 13. Validation: STOP_LIMIT without limitPrice ==="
BAD=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/triggers" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"kind\":\"STOP_LIMIT\",\"side\":\"BUY\",\"triggerPrice\":\"51000\",\"qty\":\"0.1\"}")

if [ "$BAD" = "400" ]; then
  pass "STOP_LIMIT without limitPrice returns 400"
else
  fail "expected 400 for missing limitPrice, got $BAD"
fi

echo "=== 14. Validation: STOP_MARKET with limitPrice ==="
BAD2=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/triggers" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"kind\":\"STOP_MARKET\",\"side\":\"BUY\",\"triggerPrice\":\"51000\",\"limitPrice\":\"51500\",\"qty\":\"0.1\"}")

if [ "$BAD2" = "400" ]; then
  pass "STOP_MARKET with limitPrice returns 400"
else
  fail "expected 400 for extra limitPrice, got $BAD2"
fi

echo "=== 15. STOP_LIMIT with limitPrice succeeds ==="
TRG_LIMIT=$(curl -sf -X POST "$BASE/v1/triggers" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"kind\":\"STOP_LIMIT\",\"side\":\"BUY\",\"triggerPrice\":\"51000\",\"limitPrice\":\"51500\",\"qty\":\"0.1\"}")
TRG_LIMIT_STATUS=$(echo "$TRG_LIMIT" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
TRG_LIMIT_LP=$(echo "$TRG_LIMIT" | python3 -c "import sys,json; print(json.load(sys.stdin)['limit_price'])")

if [ "$TRG_LIMIT_STATUS" = "ACTIVE" ] && [ "$TRG_LIMIT_LP" != "None" ] && [ "$TRG_LIMIT_LP" != "null" ]; then
  pass "STOP_LIMIT created with limit_price=$TRG_LIMIT_LP"
else
  fail "STOP_LIMIT creation issue: status=$TRG_LIMIT_STATUS limit_price=$TRG_LIMIT_LP"
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
echo "All triggers smoke tests passed."
