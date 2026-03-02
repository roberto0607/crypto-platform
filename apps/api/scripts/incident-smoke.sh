#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:3001"
EMAIL="incident-smoke-$(date +%s)@example.com"
ADMIN_EMAIL="incident-admin-$(date +%s)@example.com"
PASS="SmokeTest1234"
COOKIES="/tmp/incident-smoke-cookies.txt"
ADMIN_COOKIES="/tmp/incident-smoke-admin-cookies.txt"
PASS_COUNT=0
FAIL_COUNT=0

rm -f "$COOKIES" "$ADMIN_COOKIES"

# Disable background recon job to avoid interference
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

echo "=== 4. Create assets + pair + wallets + fund ==="
SHORT=$(date +%s | cut -c 6-)
BASE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"IB$SHORT\",\"name\":\"Incident BTC\",\"decimals\":8}")
BASE_ASSET_ID=$(echo "$BASE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

QUOTE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"IQ$SHORT\",\"name\":\"Incident USD\",\"decimals\":2}")
QUOTE_ASSET_ID=$(echo "$QUOTE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

PAIR=$(curl -sf -X POST "$BASE/admin/pairs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"baseAssetId\":\"$BASE_ASSET_ID\",\"quoteAssetId\":\"$QUOTE_ASSET_ID\",\"symbol\":\"IP$SHORT\",\"feeBps\":10}")
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

echo "=== 5. Place order to create a position ==="
ORDER=$(curl -sf -X POST "$BASE/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"side\":\"BUY\",\"type\":\"MARKET\",\"qty\":\"0.5\"}")
ORDER_STATUS=$(echo "$ORDER" | python3 -c "import sys,json; print(json.load(sys.stdin)['order']['status'])")
check "Order filled" "$([[ "$ORDER_STATUS" == "FILLED" ]] && echo true || echo false)" "status=$ORDER_STATUS"

echo "=== 6. Corrupt position via direct SQL ==="
docker exec cp_postgres psql -U cp -d cp -c \
  "UPDATE positions SET base_qty = base_qty + 99.0 WHERE user_id = '$TRADER_ID' AND pair_id = '$PAIR_ID';" > /dev/null
check "Position corrupted" "true"

echo "=== 7. Run reconciliation -> quarantines user + auto-creates incident ==="
RECON=$(curl -sf -X POST "$BASE/v1/admin/reconciliation/run" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
HIGH=$(echo "$RECON" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['highCount'])")
QUARANTINED=$(echo "$RECON" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']['quarantinedUserIds']; print(len(d))")
check "HIGH findings detected" "$([[ "$HIGH" -gt 0 ]] && echo true || echo false)" "high=$HIGH"
check "User quarantined" "$([[ "$QUARANTINED" -gt 0 ]] && echo true || echo false)" "quarantined=$QUARANTINED"

echo "=== 8. Verify incident auto-created ==="
INCIDENTS=$(curl -sf "$BASE/v1/admin/incidents?userId=$TRADER_ID&status=OPEN" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
INCIDENT_COUNT=$(echo "$INCIDENTS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']))")
INCIDENT_ID=$(echo "$INCIDENTS" | python3 -c "import sys,json; print(json.load(sys.stdin)['data'][0]['id'])")
INCIDENT_STATUS=$(echo "$INCIDENTS" | python3 -c "import sys,json; print(json.load(sys.stdin)['data'][0]['status'])")
check "Incident auto-created" "$([[ "$INCIDENT_COUNT" -gt 0 ]] && echo true || echo false)" "count=$INCIDENT_COUNT"
check "Incident status is OPEN" "$([[ "$INCIDENT_STATUS" == "OPEN" ]] && echo true || echo false)" "status=$INCIDENT_STATUS"

echo "=== 9. GET incident detail ==="
DETAIL=$(curl -sf "$BASE/v1/admin/incidents/$INCIDENT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
DETAIL_ID=$(echo "$DETAIL" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
check "Incident detail returned" "$([[ "$DETAIL_ID" == "$INCIDENT_ID" ]] && echo true || echo false)"

echo "=== 10. GET incident events -> has OPENED event ==="
EVENTS=$(curl -sf "$BASE/v1/admin/incidents/$INCIDENT_ID/events" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
HAS_OPENED=$(echo "$EVENTS" | python3 -c "
import sys,json
data = json.load(sys.stdin)['data']
print('true' if any(e['event_type'] == 'OPENED' for e in data) else 'false')
")
check "OPENED event exists" "$HAS_OPENED"

echo "=== 11. Attempt unquarantine -> denied (no ACK) ==="
UNQUAR_HTTP=$(curl -s -o /tmp/incident-unquar-resp.json -w "%{http_code}" \
  -X POST "$BASE/v1/admin/repair/users/$TRADER_ID/unquarantine-if-clean" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
UNQUAR_CODE=$(python3 -c "import sys,json; print(json.load(open('/tmp/incident-unquar-resp.json')).get('code',''))" 2>/dev/null || echo "")
check "Unquarantine denied 409" "$([[ "$UNQUAR_HTTP" == "409" ]] && echo true || echo false)" "http=$UNQUAR_HTTP"
check "Error code is unquarantine_not_allowed" "$([[ "$UNQUAR_CODE" == "unquarantine_not_allowed" ]] && echo true || echo false)" "code=$UNQUAR_CODE"

echo "=== 12. ACK incident ==="
ACK=$(curl -sf -X POST "$BASE/v1/admin/incidents/$INCIDENT_ID/ack" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"note\":\"Investigating drift\"}")
ACK_ID=$(echo "$ACK" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['incidentId'])")
check "Incident acknowledged" "$([[ "$ACK_ID" == "$INCIDENT_ID" ]] && echo true || echo false)"

echo "=== 13. Add note ==="
NOTE=$(curl -sf -X POST "$BASE/v1/admin/incidents/$INCIDENT_ID/note" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"note\":\"Running repair next\"}")
NOTE_ID=$(echo "$NOTE" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['incidentId'])")
check "Note added" "$([[ "$NOTE_ID" == "$INCIDENT_ID" ]] && echo true || echo false)"

echo "=== 14. APPLY repair ==="
APPLY=$(curl -sf -X POST "$BASE/v1/admin/repair/positions/apply" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$TRADER_ID\"}")
APPLY_UPDATED=$(echo "$APPLY" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['updatedPositionsCount'])")
check "Repair applied" "$([[ "$APPLY_UPDATED" -gt 0 ]] && echo true || echo false)" "updated=$APPLY_UPDATED"

# Wait for positionsVsTradesCheck freshness window
sleep 11

echo "=== 15. Targeted reconciliation for user -> clean ==="
RECON2=$(curl -sf -X POST "$BASE/v1/admin/repair/users/$TRADER_ID/reconcile" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
HIGH2=$(echo "$RECON2" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['highCount'])")
check "Recon clean after repair" "$([[ "$HIGH2" -eq 0 ]] && echo true || echo false)" "high=$HIGH2"

echo "=== 16. Resolve incident ==="
RESOLVE=$(curl -sf -X POST "$BASE/v1/admin/incidents/$INCIDENT_ID/resolve" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"resolutionSummary\":{\"action\":\"Position repaired and reconciliation clean\"}}")
RESOLVE_ID=$(echo "$RESOLVE" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['incidentId'])")
check "Incident resolved" "$([[ "$RESOLVE_ID" == "$INCIDENT_ID" ]] && echo true || echo false)"

echo "=== 17. Unquarantine-if-clean -> allowed ==="
UNQUAR2=$(curl -sf -X POST "$BASE/v1/admin/repair/users/$TRADER_ID/unquarantine-if-clean" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
UQ_STATUS=$(echo "$UNQUAR2" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['accountStatus'])")
check "User unquarantined" "$([[ "$UQ_STATUS" == "ACTIVE" ]] && echo true || echo false)" "status=$UQ_STATUS"

echo "=== 18. GET proof-pack ==="
PROOF=$(curl -sf "$BASE/v1/admin/incidents/$INCIDENT_ID/proof-pack" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
HAS_USER=$(echo "$PROOF" | python3 -c "import sys,json; print('true' if json.load(sys.stdin)['data'].get('user') else 'false')")
HAS_INCIDENTS=$(echo "$PROOF" | python3 -c "import sys,json; print('true' if len(json.load(sys.stdin)['data'].get('incidents',[])) > 0 else 'false')")
HAS_EVENTS=$(echo "$PROOF" | python3 -c "import sys,json; print('true' if len(json.load(sys.stdin)['data'].get('incidentEvents',[])) > 0 else 'false')")
HAS_REPORTS=$(echo "$PROOF" | python3 -c "import sys,json; print('true' if len(json.load(sys.stdin)['data'].get('reconciliationReports',[])) > 0 else 'false')")
HAS_REPAIRS=$(echo "$PROOF" | python3 -c "import sys,json; print('true' if len(json.load(sys.stdin)['data'].get('repairRuns',[])) > 0 else 'false')")
check "Proof pack has user" "$HAS_USER"
check "Proof pack has incidents" "$HAS_INCIDENTS"
check "Proof pack has events" "$HAS_EVENTS"
check "Proof pack has recon reports" "$HAS_REPORTS"
check "Proof pack has repair runs" "$HAS_REPAIRS"

echo "=== 19. Verify incident events timeline completeness ==="
EVENTS2=$(curl -sf "$BASE/v1/admin/incidents/$INCIDENT_ID/events" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
EVENT_TYPES=$(echo "$EVENTS2" | python3 -c "
import sys,json
data = json.load(sys.stdin)['data']
types = [e['event_type'] for e in data]
print(','.join(types))
")
HAS_ACK=$(echo "$EVENT_TYPES" | python3 -c "import sys; print('true' if 'ACKNOWLEDGED' in sys.stdin.read() else 'false')")
HAS_NOTE=$(echo "$EVENT_TYPES" | python3 -c "import sys; print('true' if 'NOTE' in sys.stdin.read() else 'false')")
HAS_RESOLVED=$(echo "$EVENT_TYPES" | python3 -c "import sys; print('true' if 'RESOLVED' in sys.stdin.read() else 'false')")
HAS_ATTEMPT=$(echo "$EVENT_TYPES" | python3 -c "import sys; print('true' if 'UNQUARANTINE_ATTEMPT' in sys.stdin.read() else 'false')")
check "Timeline has ACKNOWLEDGED" "$HAS_ACK"
check "Timeline has NOTE" "$HAS_NOTE"
check "Timeline has RESOLVED" "$HAS_RESOLVED"
check "Timeline has UNQUARANTINE_ATTEMPT" "$HAS_ATTEMPT"

# Cleanup
rm -f "$COOKIES" "$ADMIN_COOKIES" /tmp/incident-unquar-resp.json
docker exec cp_postgres psql -U cp -d cp -c \
  "UPDATE job_runs SET is_enabled = true WHERE job_name = 'reconciliation';" > /dev/null 2>&1

echo ""
echo "═══════════════════════════════"
echo "  PASS: $PASS_COUNT  FAIL: $FAIL_COUNT"
echo "═══════════════════════════════"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
echo "All incident smoke tests passed."
