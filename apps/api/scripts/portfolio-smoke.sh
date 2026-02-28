#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:3001"
EMAIL="portfolio-smoke-$(date +%s)@example.com"
PASS="SmokeTest1234"
COOKIES="/tmp/portfolio-smoke-cookies.txt"
ADMIN_EMAIL="portfolio-admin-$(date +%s)@example.com"
ADMIN_COOKIES="/tmp/portfolio-smoke-admin-cookies.txt"

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
SHORT=$(date +%s | cut -c 6-)
BASE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"PB$SHORT\",\"name\":\"Portfolio BTC\",\"decimals\":8}")
BASE_ASSET_ID=$(echo "$BASE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

QUOTE_ASSET=$(curl -sf -X POST "$BASE/admin/assets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"symbol\":\"PQ$SHORT\",\"name\":\"Portfolio USD\",\"decimals\":2}")
QUOTE_ASSET_ID=$(echo "$QUOTE_ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")

PAIR=$(curl -sf -X POST "$BASE/admin/pairs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"baseAssetId\":\"$BASE_ASSET_ID\",\"quoteAssetId\":\"$QUOTE_ASSET_ID\",\"symbol\":\"PP$SHORT\",\"feeBps\":0}")
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

echo "=== 6. Place BUY (MARKET, system fill) ==="
BUY=$(curl -sf -X POST "$BASE/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"side\":\"BUY\",\"type\":\"MARKET\",\"qty\":\"0.5\"}")
BUY_FILLS=$(echo "$BUY" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['fills']))")
if [ "$BUY_FILLS" -lt 1 ]; then
  echo "FAIL: BUY order did not fill"; exit 1
fi
echo " OK ($BUY_FILLS fill(s))"

# Let fire-and-forget snapshot writer complete
sleep 1

echo "=== 7. GET /v1/portfolio/summary ==="
SUMMARY=$(curl -sf "$BASE/v1/portfolio/summary" \
  -H "Authorization: Bearer $TOKEN")
echo "$SUMMARY" | python3 -m json.tool

python3 -c "
import sys, json
d = json.loads('$SUMMARY')
fields = ['cash_quote','holdings_quote','equity_quote','realized_pnl_quote',
          'unrealized_pnl_quote','fees_paid_quote','net_pnl_quote']
for f in fields:
    assert f in d, f'missing field: {f}'
    assert d[f] is not None, f'null field: {f}'
print('PASS: all summary fields present')
"

echo "=== 8. GET /v1/portfolio/equity ==="
EQUITY=$(curl -sf "$BASE/v1/portfolio/equity" \
  -H "Authorization: Bearer $TOKEN")
echo "$EQUITY" | python3 -m json.tool

python3 -c "
import sys, json
d = json.loads('$(echo "$EQUITY" | sed "s/'/\\\\'/g")')
assert 'data' in d, 'missing data field'
assert len(d['data']) >= 1, f'expected >= 1 equity points, got {len(d[\"data\"])}'
pt = d['data'][0]
assert 'ts' in pt, 'missing ts'
assert 'equity_quote' in pt, 'missing equity_quote'
print(f'PASS: equity curve has {len(d[\"data\"])} point(s)')
"

echo "=== 9. Place SELL (MARKET, system fill) ==="
SELL=$(curl -sf -X POST "$BASE/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pairId\":\"$PAIR_ID\",\"side\":\"SELL\",\"type\":\"MARKET\",\"qty\":\"0.25\"}")
SELL_FILLS=$(echo "$SELL" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['fills']))")
if [ "$SELL_FILLS" -lt 1 ]; then
  echo "FAIL: SELL order did not fill"; exit 1
fi
echo " OK ($SELL_FILLS fill(s))"

sleep 1

echo "=== 10. GET /v1/portfolio/performance ==="
PERF=$(curl -sf "$BASE/v1/portfolio/performance" \
  -H "Authorization: Bearer $TOKEN")
echo "$PERF" | python3 -m json.tool

python3 -c "
import sys, json
d = json.loads('$(echo "$PERF" | sed "s/'/\\\\'/g")')
fields = ['total_return_pct','max_drawdown_pct','current_drawdown_pct',
          'equity_start','equity_end','data_points','drawdown_series']
for f in fields:
    assert f in d, f'missing field: {f}'
assert d['data_points'] >= 2, f'expected >= 2 data points, got {d[\"data_points\"]}'
print(f'PASS: performance has {d[\"data_points\"]} data points, max_drawdown={d[\"max_drawdown_pct\"]}')
"

echo "=== 11. GET /v1/portfolio/equity?limit=1 (pagination) ==="
PAGE1=$(curl -sf "$BASE/v1/portfolio/equity?limit=1" \
  -H "Authorization: Bearer $TOKEN")
CURSOR=$(echo "$PAGE1" | python3 -c "import sys,json; d=json.load(sys.stdin)['nextCursor']; print(d if d else 'null')")
COUNT=$(echo "$PAGE1" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']))")

if [ "$COUNT" != "1" ]; then
  echo "FAIL: expected 1 item on page 1, got $COUNT"; exit 1
fi
if [ "$CURSOR" = "null" ]; then
  echo "FAIL: expected nextCursor on page 1"; exit 1
fi
echo "PASS: equity pagination works (1 item + nextCursor)"

rm -f "$COOKIES" "$ADMIN_COOKIES"
echo ""
echo "All portfolio smoke tests passed."
