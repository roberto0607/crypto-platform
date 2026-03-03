#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# Phase 10 PR5 — Horizontal Scaling Smoke Test
#
# Tests:
#   1. /health/instance returns expected shape
#   2. Instance identity fields are present
#   3. Leader status fields are present
#   4. Config has instanceId / instanceRole
#   5. Existing health endpoints still work
#
# Prerequisites:
#   - Server running on localhost:3001 (default INSTANCE_ROLE=ALL)
#
# Usage:
#   bash scripts/horizontal-scaling-smoke.sh
# ─────────────────────────────────────────────────────
set -euo pipefail

BASE="http://localhost:3001"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }

check_status() {
  local label="$1" url="$2" expected="$3"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "$url")
  if [ "$code" = "$expected" ]; then
    pass "$label (HTTP $code)"
  else
    fail "$label — expected $expected, got $code"
  fi
}

check_json_field() {
  local label="$1" json="$2" field="$3"
  local value
  value=$(echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d${field})" 2>/dev/null || echo "__MISSING__")
  if [ "$value" != "__MISSING__" ] && [ -n "$value" ]; then
    pass "$label = $value"
  else
    fail "$label — field missing or empty"
  fi
}

echo ""
echo "=== Phase 10 PR5: Horizontal Scaling Smoke Test ==="
echo ""

# ── 1. Existing health endpoints still work ──
echo "── 1. Existing health endpoints (regression) ──"
check_status "GET /health" "$BASE/health" "200"
check_status "GET /health/db" "$BASE/health/db" "200"
check_status "GET /health/pool" "$BASE/health/pool" "200"
check_status "GET /health/deep" "$BASE/health/deep" "200"

# ── 2. New /health/instance endpoint ──
echo ""
echo "── 2. GET /health/instance ──"
check_status "GET /health/instance" "$BASE/health/instance" "200"

INSTANCE_JSON=$(curl -s "$BASE/health/instance")

# ── 3. Instance identity fields ──
echo ""
echo "── 3. Instance identity fields ──"
check_json_field "instanceId" "$INSTANCE_JSON" "['instanceId']"
check_json_field "role" "$INSTANCE_JSON" "['role']"
check_json_field "startedAt" "$INSTANCE_JSON" "['startedAt']"
check_json_field "version" "$INSTANCE_JSON" "['version']"

# ── 4. Role value is valid ──
echo ""
echo "── 4. Role value validation ──"
ROLE=$(echo "$INSTANCE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['role'])" 2>/dev/null || echo "UNKNOWN")
if [ "$ROLE" = "API" ] || [ "$ROLE" = "WORKER" ] || [ "$ROLE" = "ALL" ]; then
  pass "role is valid ($ROLE)"
else
  fail "role is invalid: $ROLE"
fi

# ── 5. Leader status fields ──
echo ""
echo "── 5. Leader status fields ──"
check_json_field "leader.outbox" "$INSTANCE_JSON" "['leader']['outbox']"
check_json_field "leader.reconciliation" "$INSTANCE_JSON" "['leader']['reconciliation']"
check_json_field "leader.lockSampler" "$INSTANCE_JSON" "['leader']['lockSampler']"

# ── 6. In ALL mode, this instance should be leader for outbox + reconciliation ──
echo ""
echo "── 6. Leadership in ALL mode ──"
if [ "$ROLE" = "ALL" ]; then
  OUTBOX_LEADER=$(echo "$INSTANCE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['leader']['outbox'])" 2>/dev/null || echo "UNKNOWN")
  RECON_LEADER=$(echo "$INSTANCE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['leader']['reconciliation'])" 2>/dev/null || echo "UNKNOWN")
  if [ "$OUTBOX_LEADER" = "True" ]; then
    pass "outbox leader = True (expected in ALL mode)"
  else
    fail "outbox leader = $OUTBOX_LEADER (expected True in ALL mode)"
  fi
  if [ "$RECON_LEADER" = "True" ]; then
    pass "reconciliation leader = True (expected in ALL mode)"
  else
    fail "reconciliation leader = $RECON_LEADER (expected True in ALL mode)"
  fi
else
  pass "Skipped leadership check (role=$ROLE, not ALL)"
fi

# ── 7. Startup banner includes instanceId (check via /health/instance) ──
echo ""
echo "── 7. Instance ID is non-empty ──"
INSTANCE_ID=$(echo "$INSTANCE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['instanceId'])" 2>/dev/null || echo "")
if [ -n "$INSTANCE_ID" ]; then
  pass "instanceId is set: $INSTANCE_ID"
else
  fail "instanceId is empty"
fi

# ── Summary ──
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━"
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then
  echo "FAILED ($FAIL failures)"
  exit 1
fi
echo "ALL PASSED"
exit 0
