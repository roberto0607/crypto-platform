#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:3001"
ADMIN_EMAIL="jobs-admin-$(date +%s)@example.com"
PASS="SmokeTest1234"
ADMIN_COOKIES="/tmp/jobs-smoke-admin-cookies.txt"
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

echo "=== 2. GET /v1/admin/jobs — list all jobs ==="
JOBS_RESP=$(curl -sf "$BASE/v1/admin/jobs" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
JOB_COUNT=$(echo "$JOBS_RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['jobs']))")
check "List jobs returns 5 rows" "$([[ "$JOB_COUNT" == "5" ]] && echo true || echo false)" "count=$JOB_COUNT"

echo "=== 3. POST /v1/admin/jobs/reconciliation/run — manual trigger ==="
RUN_RESP=$(curl -sf -X POST "$BASE/v1/admin/jobs/reconciliation/run" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
RUN_STATUS=$(echo "$RUN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
check "Manual reconciliation run succeeded" "$([[ "$RUN_STATUS" == "SUCCESS" ]] && echo true || echo false)" "status=$RUN_STATUS"

echo "=== 4. GET /v1/admin/jobs — verify reconciliation status ==="
JOBS_RESP2=$(curl -sf "$BASE/v1/admin/jobs" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
RECON_STATUS=$(echo "$JOBS_RESP2" | python3 -c "
import sys,json
jobs = json.load(sys.stdin)['jobs']
r = [j for j in jobs if j['job_name'] == 'reconciliation'][0]
print(r['last_status'])")
check "Reconciliation last_status = SUCCESS" "$([[ "$RECON_STATUS" == "SUCCESS" ]] && echo true || echo false)" "last_status=$RECON_STATUS"

echo "=== 5. PATCH /v1/admin/jobs/reconciliation — disable ==="
DISABLE_RESP=$(curl -sf -X PATCH "$BASE/v1/admin/jobs/reconciliation" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"is_enabled":false}')
DISABLED=$(echo "$DISABLE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['job']['is_enabled'])")
check "Reconciliation disabled" "$([[ "$DISABLED" == "False" ]] && echo true || echo false)" "is_enabled=$DISABLED"

echo "=== 6. PATCH /v1/admin/jobs/reconciliation — re-enable ==="
ENABLE_RESP=$(curl -sf -X PATCH "$BASE/v1/admin/jobs/reconciliation" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"is_enabled":true}')
ENABLED=$(echo "$ENABLE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['job']['is_enabled'])")
check "Reconciliation re-enabled" "$([[ "$ENABLED" == "True" ]] && echo true || echo false)" "is_enabled=$ENABLED"

echo "=== 7. PATCH /v1/admin/jobs/reconciliation — update interval ==="
INTERVAL_RESP=$(curl -sf -X PATCH "$BASE/v1/admin/jobs/reconciliation" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"interval_seconds":120}')
NEW_INTERVAL=$(echo "$INTERVAL_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['job']['interval_seconds'])")
check "Interval updated to 120" "$([[ "$NEW_INTERVAL" == "120" ]] && echo true || echo false)" "interval=$NEW_INTERVAL"

echo "=== 8. GET /metrics — verify job_runs_total counter ==="
METRICS=$(curl -sf "$BASE/metrics")
HAS_JOB_METRIC=$(echo "$METRICS" | grep -c 'job_runs_total' || true)
check "job_runs_total in /metrics" "$([[ "$HAS_JOB_METRIC" -gt 0 ]] && echo true || echo false)" "lines=$HAS_JOB_METRIC"

echo "=== 9. POST /v1/admin/jobs/nonexistent/run — 404 ==="
NOT_FOUND_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/admin/jobs/nonexistent/run" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
check "Unknown job returns 404" "$([[ "$NOT_FOUND_HTTP" == "404" ]] && echo true || echo false)" "http=$NOT_FOUND_HTTP"

rm -f "$ADMIN_COOKIES"

echo ""
echo "═══════════════════════════════"
echo "  PASS: $PASS_COUNT  FAIL: $FAIL_COUNT"
echo "═══════════════════════════════"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
echo "All job runner smoke tests passed."
