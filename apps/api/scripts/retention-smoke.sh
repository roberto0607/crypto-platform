#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:3001"
ADMIN_EMAIL="retention-admin-$(date +%s)@example.com"
PASS="SmokeTest1234"
ADMIN_COOKIES="/tmp/retention-smoke-admin-cookies.txt"
PASS_COUNT=0
FAIL_COUNT=0

rm -f "$ADMIN_COOKIES"

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

echo "=== 1. Register + promote admin ==="
curl -sf -X POST "$BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PASS\"}" || true

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

echo "=== 2. Seed old equity snapshots (8 days ago) ==="
OLD_TS_MS=$(python3 -c "import time; print(int((time.time() - 8*86400) * 1000))")
OLD_TS_MS2=$(python3 -c "print($OLD_TS_MS + 30000)")
OLD_TS_MS3=$(python3 -c "print($OLD_TS_MS + 90000)")

docker exec cp_postgres psql -U cp -d cp -c "
  INSERT INTO equity_snapshots (user_id, ts, equity_quote)
  VALUES
    ('$ADMIN_ID', $OLD_TS_MS,  '10000.00000000'),
    ('$ADMIN_ID', $OLD_TS_MS2, '10050.00000000'),
    ('$ADMIN_ID', $OLD_TS_MS3, '10100.00000000')
  ON CONFLICT DO NOTHING;" > /dev/null

echo "=== 3. Seed recent equity snapshots (1 hour ago) ==="
NEW_TS_MS=$(python3 -c "import time; print(int((time.time() - 3600) * 1000))")
NEW_TS_MS2=$(python3 -c "print($NEW_TS_MS + 30000)")

docker exec cp_postgres psql -U cp -d cp -c "
  INSERT INTO equity_snapshots (user_id, ts, equity_quote)
  VALUES
    ('$ADMIN_ID', $NEW_TS_MS,  '11000.00000000'),
    ('$ADMIN_ID', $NEW_TS_MS2, '11050.00000000')
  ON CONFLICT DO NOTHING;" > /dev/null

TOTAL_RAW=$(docker exec cp_postgres psql -U cp -d cp -tAc \
  "SELECT count(*) FROM equity_snapshots WHERE user_id = '$ADMIN_ID';")
check "Seeded 5 raw equity snapshots" "$([[ "$TOTAL_RAW" -ge 5 ]] && echo true || echo false)" "count=$TOTAL_RAW"

echo "=== 4. GET /v1/admin/retention-status ==="
STATUS_RESP=$(curl -sf "$BASE/v1/admin/retention-status" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
HAS_CONFIG=$(echo "$STATUS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d['config']['equityRawRetentionDays']==7 else 'false')")
check "Retention status returns config" "$HAS_CONFIG"

echo "=== 5. POST /v1/admin/retention/run — trigger retention ==="
RUN_RESP=$(curl -sf -X POST "$BASE/v1/admin/retention/run" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
ROLLED_1M=$(echo "$RUN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['equityRolledUp1m'])")
RAW_DEL=$(echo "$RUN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['equityRawDeleted'])")
check "Rolled up to 1m buckets" "$([[ "$ROLLED_1M" -gt 0 ]] && echo true || echo false)" "rolledUp1m=$ROLLED_1M"
check "Deleted old raw snapshots" "$([[ "$RAW_DEL" -gt 0 ]] && echo true || echo false)" "rawDeleted=$RAW_DEL"

echo "=== 6. Verify rollup tables populated ==="
COUNT_1M=$(docker exec cp_postgres psql -U cp -d cp -tAc \
  "SELECT count(*) FROM equity_snapshots_1m WHERE user_id = '$ADMIN_ID';")
check "equity_snapshots_1m has rows" "$([[ "$COUNT_1M" -gt 0 ]] && echo true || echo false)" "count=$COUNT_1M"

echo "=== 7. Verify recent raw snapshots survived ==="
RECENT_RAW=$(docker exec cp_postgres psql -U cp -d cp -tAc \
  "SELECT count(*) FROM equity_snapshots WHERE user_id = '$ADMIN_ID';")
check "Recent raw snapshots preserved" "$([[ "$RECENT_RAW" -ge 2 ]] && echo true || echo false)" "count=$RECENT_RAW"

echo "=== 8. GET /v1/admin/retention/stats ==="
STATS_RESP=$(curl -sf "$BASE/v1/admin/retention/stats" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
TABLE_COUNT=$(echo "$STATS_RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['stats']['tables']))")
check "Stats returns table info" "$([[ "$TABLE_COUNT" -ge 4 ]] && echo true || echo false)" "tables=$TABLE_COUNT"

echo "=== 9. Idempotent re-run ==="
RUN2_RESP=$(curl -sf -X POST "$BASE/v1/admin/retention/run" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
RAW_DEL2=$(echo "$RUN2_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['equityRawDeleted'])")
check "Re-run deletes 0 raw rows (idempotent)" "$([[ "$RAW_DEL2" == "0" ]] && echo true || echo false)" "rawDeleted=$RAW_DEL2"

echo "=== 10. Metrics include retention counters ==="
METRICS=$(curl -sf "$BASE/metrics")
HAS_RETENTION=$(echo "$METRICS" | grep -c 'retention_rows_deleted_total' || true)
check "retention_rows_deleted_total in /metrics" "$([[ "$HAS_RETENTION" -gt 0 ]] && echo true || echo false)" "lines=$HAS_RETENTION"

rm -f "$ADMIN_COOKIES"

echo ""
echo "═══════════════════════════════"
echo "  PASS: $PASS_COUNT  FAIL: $FAIL_COUNT"
echo "═══════════════════════════════"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
echo "All retention smoke tests passed."
