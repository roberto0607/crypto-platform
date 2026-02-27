#!/usr/bin/env python3
"""Phase 6 PR3 Smoke Tests — Risk Controls + Circuit Breakers"""

import subprocess, json, sys, time

BASE = "http://localhost:3001"
TS = str(int(time.time()))[-4:]

def api(method, path, token=None, body=None, headers=None):
    cmd = ["curl", "-s", "-X", method, f"{BASE}{path}"]
    if token:
        cmd += ["-H", f"Authorization: Bearer {token}"]
    if body:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    if headers:
        for k, v in headers.items():
            cmd += ["-H", f"{k}: {v}"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return json.loads(result.stdout)
    except:
        print(f"FAILED to parse response for {method} {path}")
        print(f"stdout: {result.stdout}")
        print(f"stderr: {result.stderr}")
        sys.exit(1)

def check(label, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    print(f"  [{status}] {label}" + (f" — {detail}" if detail and not condition else ""))
    if not condition:
        sys.exit(1)

def psql(sql):
    subprocess.run([
        "docker", "exec", "cp_postgres",
        "psql", "-U", "cp", "-d", "cp", "-c", sql
    ], capture_output=True)

print("=== Phase 6 PR3 Smoke Tests — Risk Controls + Circuit Breakers ===\n")

# ── Setup: Register admin + user, create assets, wallets, pair ──

print("Setup: Register admin (A) + user (B)")

regA = api("POST", "/auth/register", body={"email": f"riskA{TS}@test.com", "password": "testpass123"})
check("Register A", regA.get("ok"), json.dumps(regA))

regB = api("POST", "/auth/register", body={"email": f"riskB{TS}@test.com", "password": "testpass123"})
check("Register B", regB.get("ok"), json.dumps(regB))

loginA = api("POST", "/auth/login", body={"email": f"riskA{TS}@test.com", "password": "testpass123"})
check("Login A", loginA.get("ok"))
tokenA = loginA["accessToken"]
userAId = loginA["user"]["id"]

loginB = api("POST", "/auth/login", body={"email": f"riskB{TS}@test.com", "password": "testpass123"})
check("Login B", loginB.get("ok"))
tokenB = loginB["accessToken"]
userBId = loginB["user"]["id"]

# Promote A to ADMIN
psql(f"UPDATE users SET role='ADMIN' WHERE id='{userAId}'")
loginA2 = api("POST", "/auth/login", body={"email": f"riskA{TS}@test.com", "password": "testpass123"})
check("Re-login A (admin)", loginA2.get("ok"))
tokenA = loginA2["accessToken"]

print("\nSetup: Create assets + pair")
btc = api("POST", "/admin/assets", tokenA, {"symbol": f"RBTC{TS}", "name": f"RiskBTC{TS}", "decimals": 8})
check("Create BTC", btc.get("ok"), json.dumps(btc))
btcId = btc["asset"]["id"]

usdt = api("POST", "/admin/assets", tokenA, {"symbol": f"RUSD{TS}", "name": f"RiskUSDT{TS}", "decimals": 8})
check("Create USDT", usdt.get("ok"), json.dumps(usdt))
usdtId = usdt["asset"]["id"]

print("\nSetup: Create wallets + fund")
wA_btc = api("POST", "/wallets", tokenA, {"assetId": btcId})
wA_usdt = api("POST", "/wallets", tokenA, {"assetId": usdtId})
wB_btc = api("POST", "/wallets", tokenB, {"assetId": btcId})
wB_usdt = api("POST", "/wallets", tokenB, {"assetId": usdtId})

wA_btcId = wA_btc["wallet"]["id"]
wA_usdtId = wA_usdt["wallet"]["id"]
wB_btcId = wB_btc["wallet"]["id"]
wB_usdtId = wB_usdt["wallet"]["id"]

# Credit generous balances
api("POST", f"/admin/wallets/{wA_usdtId}/credit", tokenA, {"amount": "500000"})
api("POST", f"/admin/wallets/{wA_btcId}/credit", tokenA, {"amount": "100"})
api("POST", f"/admin/wallets/{wB_usdtId}/credit", tokenA, {"amount": "500000"})
api("POST", f"/admin/wallets/{wB_btcId}/credit", tokenA, {"amount": "100"})

pair = api("POST", "/admin/pairs", tokenA, {
    "baseAssetId": btcId, "quoteAssetId": usdtId,
    "symbol": f"RBTC_USDT_{TS}", "feeBps": 30
})
check("Create pair", pair.get("ok"), json.dumps(pair))
pairId = pair["pair"]["id"]

setPrice = api("PATCH", f"/admin/pairs/{pairId}/price", tokenA, {"price": "50000"})
check("Set last_price=50000", setPrice.get("ok"))

# ── Test 1: Set tight risk limits via admin ──
print("\n--- Test 1: Admin sets risk limits ---")

limResult = api("PUT", "/admin/risk-limits", tokenA, {
    "user_id": None,
    "pair_id": None,
    "max_order_notional_quote": "200000",
    "max_position_base_qty": "50",
    "max_open_orders_per_pair": "10",
    "max_price_deviation_bps": "500"
})
check("Upsert global risk limits", limResult.get("ok"), json.dumps(limResult))

limList = api("GET", "/admin/risk-limits", tokenA)
check("List risk limits", limList.get("ok") and len(limList["limits"]) >= 1)

# ── Test 2: Valid order passes risk checks ──
print("\n--- Test 2: Valid order passes risk checks ---")

order1 = api("POST", "/orders", tokenB, {
    "pairId": pairId, "side": "BUY", "type": "MARKET", "qty": "1"
})
check("Valid order accepted", order1.get("ok"), json.dumps(order1))
check("Order status FILLED", order1["order"]["status"] == "FILLED")

# ── Test 3: Max notional exceeded (order too large) ──
print("\n--- Test 3: Max notional exceeded ---")

# Set a very tight notional limit for user B specifically
api("PUT", "/admin/risk-limits", tokenA, {
    "user_id": userBId,
    "pair_id": pairId,
    "max_order_notional_quote": "1000"
})

# B tries to buy 1 BTC at ~50000 → notional 50000 > 1000 limit
order2 = api("POST", "/orders", tokenB, {
    "pairId": pairId, "side": "BUY", "type": "MARKET", "qty": "1"
})
check("Notional exceeded → rejected", order2.get("error") == "risk_check_failed", json.dumps(order2))
check("Risk code MAX_NOTIONAL", order2.get("code") == "MAX_NOTIONAL", json.dumps(order2))

# ── Test 4: Price deviation rejected (fat-finger LIMIT) ──
print("\n--- Test 4: Price deviation rejected ---")

# Reset B's per-user limit to allow bigger notional but keep deviation check
api("PUT", "/admin/risk-limits", tokenA, {
    "user_id": userBId,
    "pair_id": pairId,
    "max_order_notional_quote": "500000",
    "max_price_deviation_bps": "200"
})

# B places LIMIT BUY at 70000 with last_price=50000 → 40% deviation > 200bps (2%)
order3 = api("POST", "/orders", tokenB, {
    "pairId": pairId, "side": "BUY", "type": "LIMIT", "qty": "1", "limitPrice": "70000"
})
check("Fat-finger LIMIT rejected", order3.get("error") == "risk_check_failed", json.dumps(order3))
check("Risk code PRICE_DEVIATION", order3.get("code") == "PRICE_DEVIATION", json.dumps(order3))

# ── Test 5: MARKET order skips price deviation check ──
print("\n--- Test 5: MARKET order skips price deviation ---")

# Reset to generous limits for user B
api("PUT", "/admin/risk-limits", tokenA, {
    "user_id": userBId,
    "pair_id": pairId,
    "max_order_notional_quote": "500000",
    "max_price_deviation_bps": "200",
    "max_position_base_qty": "100"
})

# MARKET order should skip deviation check even with tight deviation limit
order4 = api("POST", "/orders", tokenB, {
    "pairId": pairId, "side": "BUY", "type": "MARKET", "qty": "0.5"
})
check("MARKET order accepted (skips deviation)", order4.get("ok"), json.dumps(order4))

# ── Test 6: Trip breaker → orders blocked ──
print("\n--- Test 6: Trip breaker, orders blocked ---")

# Manually trip a price dislocation breaker for our pair via DB
psql(f"""
INSERT INTO circuit_breakers (breaker_key, status, reason, closes_at)
VALUES ('PRICE_DISLOCATION:{pairId}', 'OPEN', 'smoke test trip', NOW() + INTERVAL '10 minutes')
ON CONFLICT (breaker_key) DO UPDATE SET status='OPEN', reason='smoke test trip', closes_at=NOW() + INTERVAL '10 minutes'
""")

order5 = api("POST", "/orders", tokenB, {
    "pairId": pairId, "side": "BUY", "type": "MARKET", "qty": "0.1"
})
check("Breaker blocks order", order5.get("error") == "risk_check_failed", json.dumps(order5))
check("Risk code BREAKER_OPEN", order5.get("code") == "BREAKER_OPEN", json.dumps(order5))

# ── Test 7: GET /risk/status shows breaker ──
print("\n--- Test 7: GET /risk/status ---")

riskStatus = api("GET", "/risk/status", tokenB)
check("Risk status ok", riskStatus.get("ok"), json.dumps(riskStatus))
check("Trading not allowed", riskStatus.get("trading_allowed") == False, json.dumps(riskStatus))
check("Has breaker entry", len(riskStatus.get("breakers", [])) >= 1)

# ── Test 8: GET /admin/breakers ──
print("\n--- Test 8: GET /admin/breakers ---")

breakerList = api("GET", "/admin/breakers", tokenA)
check("Admin breakers list", breakerList.get("ok"), json.dumps(breakerList))
check("Has open breakers", len(breakerList.get("breakers", [])) >= 1)

# ── Test 9: Reset breaker → orders allowed ──
print("\n--- Test 9: Reset breaker, orders allowed ---")

resetResult = api("POST", "/admin/breakers/reset", tokenA, {
    "breaker_key": f"PRICE_DISLOCATION:{pairId}"
})
check("Breaker reset", resetResult.get("ok"), json.dumps(resetResult))
check("Reset count >= 1", resetResult.get("reset_count", 0) >= 1)

# Verify orders work again
order6 = api("POST", "/orders", tokenB, {
    "pairId": pairId, "side": "BUY", "type": "MARKET", "qty": "0.1"
})
check("Order accepted after reset", order6.get("ok"), json.dumps(order6))

# Verify risk status is clear
riskStatus2 = api("GET", "/risk/status", tokenB)
check("Trading allowed again", riskStatus2.get("trading_allowed") == True, json.dumps(riskStatus2))

print("\n=== All Phase 6 PR3 risk smoke tests passed ===")
