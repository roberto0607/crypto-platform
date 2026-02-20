#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:3001"
EMAIL="smoke-$(date +%s)@example.com"
PASS="SmokeTest1234"
COOKIES="/tmp/smoke-cookies.txt"

rm -f "$COOKIES"

echo "=== 1. Register (ignore 409) ==="
curl -sf -X POST "$BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" || true
echo ""

echo "=== 2. Login ==="
LOGIN=$(curl -sf -c "$COOKIES" -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
echo "$LOGIN" | python3 -m json.tool
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
echo ""

echo "=== 3. /auth/me ==="
curl -sf "$BASE/auth/me" -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
echo ""

echo "=== 4. Refresh (rotate) ==="
curl -sf -b "$COOKIES" -c "$COOKIES" -X POST "$BASE/auth/refresh" | python3 -m json.tool
echo ""

echo "=== 5. Logout ==="
curl -sf -b "$COOKIES" -c "$COOKIES" -X POST "$BASE/auth/logout" | python3 -m json.tool
echo ""

echo "=== 6. Refresh after logout (expect 401) ==="
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIES" -c "$COOKIES" -X POST "$BASE/auth/refresh")
echo "HTTP $HTTP_CODE"
if [ "$HTTP_CODE" = "401" ]; then
  echo "PASS: refresh after logout correctly returned 401"
else
  echo "FAIL: expected 401, got $HTTP_CODE"
  rm -f "$COOKIES"
  exit 1
fi

rm -f "$COOKIES"
echo ""
echo "All smoke tests passed."
