#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:3001"
EMAIL="recon-smoke-$(date +%s)@example.com"
ADMIN_EMAIL="recon-admin-$(date +%s)@example.com"
PASS="SmokeTest1234"
COOKIES="/tmp/recon-smoke-cookies.txt"
ADMIN_COOKIES="/tmp/recon-smoke-admin-cookies.txt"
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

echo "=== 4. Create assets + wallets ==="
SHORT=$(date +%s | cut -c 6-)
BASE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"RB$SHORT\",\"name\":\"Recon BTC\",\"decimals\":8}")
BASE_ASSET_ID=$(echo "$BASE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

QUOTE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"RQ$SHORT\",\"name\":\"Recon USD\",\"decimals\":2}")
QUOTE_ASSET_ID=$(echo "$QUOTE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

# Create wallets
BW=$(curl -sf -X POST "$BASE/wallets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"assetId\":\"$BASE_ASSET_ID\"}")

QW=$(curl -sf -X POST "$BASE/wallets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"assetId\":\"$QUOTE_ASSET_ID\"}")
QW_ID=$(echo "$QW" | python3 -c "import sys,json; print(json.load(sys.stdin)['wallet']['id'])")

# Credit quote wallet
curl -sf -X POST "$BASE/admin/wallets/$QW_ID/credit" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"amount\":\"100000\"}" > /dev/null
echo " OK"

echo "=== 5. Intentionally create wallet/ledger drift via direct SQL ==="
docker exec cp_postgres psql -U cp -d cp -c \
  "UPDATE wallets SET balance = balance + 999 WHERE id = '$QW_ID';" > /dev/null
check "Drift injected (balance += 999)" "true"

echo "=== 6. Run reconciliation via admin endpoint ==="
RECON=$(curl -sf -X POST "$BASE/v1/admin/reconciliation/run" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
FINDINGS=$(echo "$RECON" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['findingsCount'])")
HIGH=$(echo "$RECON" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['highCount'])")
QUARANTINED=$(echo "$RECON" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']['quarantinedUserIds']; print(len(d))")
RUN_ID=$(echo "$RECON" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['runId'])")
check "Reconciliation found findings" "$([[ "$FINDINGS" -gt 0 ]] && echo true || echo false)" "findings=$FINDINGS"
check "HIGH findings detected" "$([[ "$HIGH" -gt 0 ]] && echo true || echo false)" "high=$HIGH"
check "User quarantined" "$([[ "$QUARANTINED" -gt 0 ]] && echo true || echo false)" "quarantined=$QUARANTINED"

echo "=== 7. GET reconciliation reports ==="
REPORTS=$(curl -sf "$BASE/v1/admin/reconciliation/reports?userId=$TRADER_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
REPORT_COUNT=$(echo "$REPORTS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']))")
HAS_MISMATCH=$(echo "$REPORTS" | python3 -c "
import sys,json
data = json.load(sys.stdin)['data']
print('true' if any(r['checkName'] == 'WALLET_LEDGER_MISMATCH' for r in data) else 'false')
")
check "Reports returned for user" "$([[ "$REPORT_COUNT" -gt 0 ]] && echo true || echo false)" "count=$REPORT_COUNT"
check "WALLET_LEDGER_MISMATCH found" "$HAS_MISMATCH"

echo "=== 8. GET latest run summary ==="
LATEST=$(curl -sf "$BASE/v1/admin/reconciliation/runs/latest" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
LATEST_RUN=$(echo "$LATEST" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['runId'])")
check "Latest run matches" "$([[ "$LATEST_RUN" == "$RUN_ID" ]] && echo true || echo false)" "runId=$LATEST_RUN"

echo "=== 9. Quarantined user cannot trade ==="
# Create a pair so we can attempt an order
PAIR=$(curl -sf -X POST "$BASE/admin/pairs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"baseAssetId\":\"$BASE_ASSET_ID\",\"quoteAssetId\":\"$QUOTE_ASSET_ID\",\"symbol\":\"RP$SHORT\",\"feeBps\":5}")
PAIR_ID=$(echo "$PAIR" | python3 -c "import sys,json; print(json.load(sys.stdin)['pair']['id'])")

curl -sf -X PATCH "$BASE/admin/pairs/$PAIR_ID/price" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"price\":\"50000\"}" > /dev/null

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

ORDER_HTTP=$(curl -s -o /tmp/recon-order-resp.json -w "%{http_code}" -X POST "$BASE/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"side\":\"BUY\",\"type\":\"MARKET\",\"qty\":\"0.001\"}")
ORDER_CODE=$(python3 -c "import sys,json; d=json.load(open('/tmp/recon-order-resp.json')); print(d.get('details',{}).get('code', d.get('code','')))" 2>/dev/null || echo "")
check "Quarantined order rejected 403" "$([[ "$ORDER_HTTP" == "403" ]] && echo true || echo false)" "http=$ORDER_HTTP"
check "Error code is ACCOUNT_QUARANTINED" "$([[ "$ORDER_CODE" == "ACCOUNT_QUARANTINED" ]] && echo true || echo false)" "code=$ORDER_CODE"

echo "=== 10. Unquarantine user ==="
UNQUAR=$(curl -sf -X POST "$BASE/v1/admin/users/$TRADER_ID/unquarantine" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
UQ_STATUS=$(echo "$UNQUAR" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['accountStatus'])")
check "User unquarantined" "$([[ "$UQ_STATUS" == "ACTIVE" ]] && echo true || echo false)" "status=$UQ_STATUS"

echo "=== 11. Unquarantined user can trade again ==="
ORDER2=$(curl -sf -X POST "$BASE/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"side\":\"BUY\",\"type\":\"MARKET\",\"qty\":\"0.001\"}")
ORDER2_STATUS=$(echo "$ORDER2" | python3 -c "import sys,json; print(json.load(sys.stdin)['order']['status'])")
check "Unquarantined order accepted" "$([[ "$ORDER2_STATUS" == "FILLED" ]] && echo true || echo false)" "status=$ORDER2_STATUS"

# Cleanup
rm -f "$COOKIES" "$ADMIN_COOKIES" /tmp/recon-order-resp.json

echo ""
echo "═══════════════════════════════"
echo "  PASS: $PASS_COUNT  FAIL: $FAIL_COUNT"
echo "═══════════════════════════════"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
echo "All reconciliation smoke tests passed."
