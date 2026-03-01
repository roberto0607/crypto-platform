#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:3001"
EMAIL="repair-smoke-$(date +%s)@example.com"
ADMIN_EMAIL="repair-admin-$(date +%s)@example.com"
PASS="SmokeTest1234"
COOKIES="/tmp/repair-smoke-cookies.txt"
ADMIN_COOKIES="/tmp/repair-smoke-admin-cookies.txt"
PASS_COUNT=0
FAIL_COUNT=0

rm -f "$COOKIES" "$ADMIN_COOKIES"

# Clear stale breakers and disable background recon job to avoid interference
docker exec cp_postgres psql -U cp -d cp -c \
  "DELETE FROM circuit_breakers WHERE breaker_key = 'RECONCILIATION_CRITICAL';
   UPDATE job_runs SET is_enabled = false WHERE job_name = 'reconciliation';" > /dev/null 2>&1

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
  -d "{\"symbol\":\"XB$SHORT\",\"name\":\"Repair BTC\",\"decimals\":8}")
BASE_ASSET_ID=$(echo "$BASE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

QUOTE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"XQ$SHORT\",\"name\":\"Repair USD\",\"decimals\":2}")
QUOTE_ASSET_ID=$(echo "$QUOTE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

PAIR=$(curl -sf -X POST "$BASE/admin/pairs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"baseAssetId\":\"$BASE_ASSET_ID\",\"quoteAssetId\":\"$QUOTE_ASSET_ID\",\"symbol\":\"XP$SHORT\",\"feeBps\":10}")
PAIR_ID=$(echo "$PAIR" | python3 -c "import sys,json; print(json.load(sys.stdin)['pair']['id'])")

curl -sf -X PATCH "$BASE/admin/pairs/$PAIR_ID/price" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"price\":\"50000\"}" > /dev/null

# Wallets for trader
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

echo "=== 5. Place order to create a position ==="
ORDER=$(curl -sf -X POST "$BASE/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"side\":\"BUY\",\"type\":\"MARKET\",\"qty\":\"0.5\"}")
ORDER_STATUS=$(echo "$ORDER" | python3 -c "import sys,json; print(json.load(sys.stdin)['order']['status'])")
check "Order filled" "$([[ "$ORDER_STATUS" == "FILLED" ]] && echo true || echo false)" "status=$ORDER_STATUS"

echo "=== 6. Verify position exists ==="
POS_QTY=$(docker exec cp_postgres psql -U cp -d cp -t -A -c \
  "SELECT base_qty FROM positions WHERE user_id = '$TRADER_ID' AND pair_id = '$PAIR_ID';")
check "Position has qty" "$([[ -n "$POS_QTY" ]] && echo true || echo false)" "qty=$POS_QTY"

echo "=== 7. Corrupt position via direct SQL ==="
docker exec cp_postgres psql -U cp -d cp -c \
  "UPDATE positions SET base_qty = base_qty + 99.0 WHERE user_id = '$TRADER_ID' AND pair_id = '$PAIR_ID';" > /dev/null
CORRUPT_QTY=$(docker exec cp_postgres psql -U cp -d cp -t -A -c \
  "SELECT base_qty FROM positions WHERE user_id = '$TRADER_ID' AND pair_id = '$PAIR_ID';")
check "Position corrupted" "true" "qty=$CORRUPT_QTY"

echo "=== 8. Run reconciliation -> user quarantined ==="
RECON=$(curl -sf -X POST "$BASE/v1/admin/reconciliation/run" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
HIGH=$(echo "$RECON" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['highCount'])")
QUARANTINED=$(echo "$RECON" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']['quarantinedUserIds']; print(len(d))")
check "HIGH findings detected" "$([[ "$HIGH" -gt 0 ]] && echo true || echo false)" "high=$HIGH"
check "User quarantined" "$([[ "$QUARANTINED" -gt 0 ]] && echo true || echo false)" "quarantined=$QUARANTINED"

echo "=== 9. DRY_RUN repair -> shows diff ==="
DRY_RUN=$(curl -sf -X POST "$BASE/v1/admin/repair/positions/dry-run" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$TRADER_ID\"}")
DRY_CHANGED=$(echo "$DRY_RUN" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['changedPairsCount'])")
DRY_UPDATED=$(echo "$DRY_RUN" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['updatedPositionsCount'])")
DRY_MODE=$(echo "$DRY_RUN" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['mode'])")
check "DRY_RUN found diffs" "$([[ "$DRY_CHANGED" -gt 0 ]] && echo true || echo false)" "changed=$DRY_CHANGED"
check "DRY_RUN did not write" "$([[ "$DRY_UPDATED" -eq 0 ]] && echo true || echo false)" "updated=$DRY_UPDATED"
check "Mode is DRY_RUN" "$([[ "$DRY_MODE" == "DRY_RUN" ]] && echo true || echo false)" "mode=$DRY_MODE"

echo "=== 10. APPLY repair -> positions corrected ==="
APPLY=$(curl -sf -X POST "$BASE/v1/admin/repair/positions/apply" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$TRADER_ID\"}")
APPLY_UPDATED=$(echo "$APPLY" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['updatedPositionsCount'])")
APPLY_MODE=$(echo "$APPLY" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['mode'])")
REPAIR_RUN_ID=$(echo "$APPLY" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['repairRunId'])")
check "APPLY wrote positions" "$([[ "$APPLY_UPDATED" -gt 0 ]] && echo true || echo false)" "updated=$APPLY_UPDATED"
check "Mode is APPLY" "$([[ "$APPLY_MODE" == "APPLY" ]] && echo true || echo false)" "mode=$APPLY_MODE"

echo "=== 11. Verify position restored ==="
RESTORED_QTY=$(docker exec cp_postgres psql -U cp -d cp -t -A -c \
  "SELECT base_qty FROM positions WHERE user_id = '$TRADER_ID' AND pair_id = '$PAIR_ID';")
check "Position qty restored" "$([[ "$RESTORED_QTY" == "$POS_QTY" ]] && echo true || echo false)" "restored=$RESTORED_QTY expected=$POS_QTY"

# Wait for 10s freshness window in positionsVsTradesCheck
sleep 11

echo "=== 12. Targeted reconcile for user -> clean ==="
TARGETED=$(curl -sf -X POST "$BASE/v1/admin/repair/users/$TRADER_ID/reconcile" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
TARGETED_HIGH=$(echo "$TARGETED" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['highCount'])")
check "Targeted recon clean" "$([[ "$TARGETED_HIGH" -eq 0 ]] && echo true || echo false)" "high=$TARGETED_HIGH"

echo "=== 13. Unquarantine-if-clean -> succeeds ==="
UNQUAR=$(curl -sf -X POST "$BASE/v1/admin/repair/users/$TRADER_ID/unquarantine-if-clean" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
UQ_STATUS=$(echo "$UNQUAR" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['accountStatus'])")
check "User unquarantined" "$([[ "$UQ_STATUS" == "ACTIVE" ]] && echo true || echo false)" "status=$UQ_STATUS"

echo "=== 14. Place order -> allowed ==="
ORDER2=$(curl -sf -X POST "$BASE/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"side\":\"BUY\",\"type\":\"MARKET\",\"qty\":\"0.25\"}")
ORDER2_STATUS=$(echo "$ORDER2" | python3 -c "import sys,json; print(json.load(sys.stdin)['order']['status'])")
check "Order accepted after unquarantine" "$([[ "$ORDER2_STATUS" == "FILLED" ]] && echo true || echo false)" "status=$ORDER2_STATUS"

echo "=== 15. GET repair runs -> lists runs ==="
RUNS=$(curl -sf "$BASE/v1/admin/repair/runs?userId=$TRADER_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
RUN_COUNT=$(echo "$RUNS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']))")
check "Repair runs listed" "$([[ "$RUN_COUNT" -ge 2 ]] && echo true || echo false)" "count=$RUN_COUNT (expect >=2: DRY_RUN + APPLY)"

# Cleanup
rm -f "$COOKIES" "$ADMIN_COOKIES"
docker exec cp_postgres psql -U cp -d cp -c \
  "UPDATE job_runs SET is_enabled = true WHERE job_name = 'reconciliation';" > /dev/null 2>&1

echo ""
echo "═══════════════════════════════"
echo "  PASS: $PASS_COUNT  FAIL: $FAIL_COUNT"
echo "═══════════════════════════════"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
echo "All repair smoke tests passed."
