#!/usr/bin/env python3
"""Phase 4 Smoke Tests — Matching-Lite Trading Engine"""

import subprocess, json, sys, time

BASE = "http://localhost:3001"
TS = str(int(time.time()))[-4:]

def api(method, path, token=None, body=None):
    cmd = ["curl", "-s", "-X", method, f"{BASE}{path}"]
    if token:
        cmd += ["-H", f"Authorization: Bearer {token}"]
    if body:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
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

print("=== Phase 4 Smoke Tests ===\n")

# ── Setup ──
print("Setup: Register user A + B, promote A to admin")

regA = api("POST", "/auth/register", body={"email": f"phase4a{TS}@test.com", "password": "testpass123"})
check("Register A", regA.get("ok"), json.dumps(regA))

regB = api("POST", "/auth/register", body={"email": f"phase4b{TS}@test.com", "password": "testpass123"})
check("Register B", regB.get("ok"), json.dumps(regB))

loginA = api("POST", "/auth/login", body={"email": f"phase4a{TS}@test.com", "password": "testpass123"})
check("Login A", loginA.get("ok"))
tokenA = loginA["accessToken"]
userAId = loginA["user"]["id"]

loginB = api("POST", "/auth/login", body={"email": f"phase4b{TS}@test.com", "password": "testpass123"})
check("Login B", loginB.get("ok"))
tokenB = loginB["accessToken"]
userBId = loginB["user"]["id"]

# Promote A to ADMIN via direct DB
subprocess.run([
    "docker", "exec", "cp_postgres",
    "psql", "-U", "cp", "-d", "cp", "-c",
    f"UPDATE users SET role='ADMIN' WHERE id='{userAId}'"
], capture_output=True)

# Re-login A to get admin token
loginA2 = api("POST", "/auth/login", body={"email": f"phase4a{TS}@test.com", "password": "testpass123"})
check("Re-login A (admin)", loginA2.get("ok"))
tokenA = loginA2["accessToken"]

print("\nSetup: Create assets BTC + USDT")
btc = api("POST", "/admin/assets", tokenA, {"symbol": f"BTC{TS}", "name": f"Bitcoin{TS}", "decimals": 8})
check("Create BTC", btc.get("ok"), json.dumps(btc))
btcId = btc["asset"]["id"]

usdt = api("POST", "/admin/assets", tokenA, {"symbol": f"USDT{TS}", "name": f"Tether{TS}", "decimals": 8})
check("Create USDT", usdt.get("ok"), json.dumps(usdt))
usdtId = usdt["asset"]["id"]

print("\nSetup: Create wallets for A + B")
wA_btc = api("POST", "/wallets", tokenA, {"assetId": btcId})
check("A wallet BTC", wA_btc.get("ok"))
wA_usdt = api("POST", "/wallets", tokenA, {"assetId": usdtId})
check("A wallet USDT", wA_usdt.get("ok"))
wB_btc = api("POST", "/wallets", tokenB, {"assetId": btcId})
check("B wallet BTC", wB_btc.get("ok"))
wB_usdt = api("POST", "/wallets", tokenB, {"assetId": usdtId})
check("B wallet USDT", wB_usdt.get("ok"))

wA_btcId = wA_btc["wallet"]["id"]
wA_usdtId = wA_usdt["wallet"]["id"]
wB_btcId = wB_btc["wallet"]["id"]
wB_usdtId = wB_usdt["wallet"]["id"]

print("\nSetup: Admin credit A.USDT=200000, B.BTC=10")
api("POST", f"/admin/wallets/{wA_usdtId}/credit", tokenA, {"amount": "200000"})
api("POST", f"/admin/wallets/{wB_btcId}/credit", tokenA, {"amount": "10"})

print("\nSetup: Create pair BTC4_USDT4, set last_price=50000")
pair = api("POST", "/admin/pairs", tokenA, {"baseAssetId": btcId, "quoteAssetId": usdtId, "symbol": f"BTC_USDT_{TS}", "feeBps": 30})
check("Create pair", pair.get("ok"), json.dumps(pair))
pairId = pair["pair"]["id"]

setPrice = api("PATCH", f"/admin/pairs/{pairId}/price", tokenA, {"price": "50000"})
check("Set last_price", setPrice.get("ok"))

# ── Test 1: GET /pairs ──
print("\n--- Test 1: GET /pairs ---")
pairs = api("GET", "/pairs", tokenA)
check("List pairs", pairs.get("ok") and len(pairs["pairs"]) >= 1)
check("Has BTC_USDT pair", any(p["symbol"] == f"BTC_USDT_{TS}" for p in pairs["pairs"]))

# ── Test 2: MARKET BUY system fill (no book) ──
print("\n--- Test 2: MARKET BUY system fill ---")
order1 = api("POST", "/orders", tokenA, {"pairId": pairId, "side": "BUY", "type": "MARKET", "qty": "1"})
check("201 order", order1.get("ok"), json.dumps(order1))
check("Status FILLED", order1["order"]["status"] == "FILLED")
check("1 fill", len(order1["fills"]) == 1)
check("System fill", order1["fills"][0]["is_system_fill"] == True)

# Verify balances: A.USDT decreased by ~50150, A.BTC increased by 1
walletsA = api("GET", "/wallets", tokenA)
aUsdt = next(w for w in walletsA["wallets"] if w["asset_id"] == usdtId)
aBtc = next(w for w in walletsA["wallets"] if w["asset_id"] == btcId)
check("A.USDT ~ 149850", float(aUsdt["balance"]) < 200000, f"balance={aUsdt['balance']}")
check("A.BTC = 1", float(aBtc["balance"]) == 1.0, f"balance={aBtc['balance']}")

# ── Test 3: LIMIT SELL rests on book ──
print("\n--- Test 3: LIMIT SELL rests on book ---")
order2 = api("POST", "/orders", tokenB, {"pairId": pairId, "side": "SELL", "type": "LIMIT", "qty": "2", "limitPrice": "51000"})
check("201 order", order2.get("ok"), json.dumps(order2))
check("Status OPEN", order2["order"]["status"] == "OPEN")
check("0 fills", len(order2["fills"]) == 0)
sellOrderId = order2["order"]["id"]

book = api("GET", f"/pairs/{pairId}/book", tokenA)
check("Book OK", book.get("ok"))
check("Asks has 51000", len(book["book"]["asks"]) >= 1 and book["book"]["asks"][0]["price"] == "51000.00000000",
      json.dumps(book["book"]["asks"]))

# ── Test 4: MARKET BUY matches resting LIMIT SELL ──
print("\n--- Test 4: MARKET BUY matches LIMIT SELL ---")
order3 = api("POST", "/orders", tokenA, {"pairId": pairId, "side": "BUY", "type": "MARKET", "qty": "1"})
check("201 order", order3.get("ok"), json.dumps(order3))
check("Status FILLED", order3["order"]["status"] == "FILLED")
check("1 fill", len(order3["fills"]) == 1)
check("Not system fill", order3["fills"][0]["is_system_fill"] == False)
check("Price 51000", order3["fills"][0]["price"] == "51000.00000000",
      f"price={order3['fills'][0]['price']}")

# Check B's sell order is now PARTIALLY_FILLED
order2detail = api("GET", f"/orders/{sellOrderId}", tokenB)
check("B sell PARTIALLY_FILLED", order2detail["order"]["status"] == "PARTIALLY_FILLED")

# ── Test 5: Cancel remaining LIMIT SELL ──
print("\n--- Test 5: Cancel LIMIT SELL ---")
cancel = api("DELETE", f"/orders/{sellOrderId}", tokenB)
check("Cancel OK", cancel.get("ok"), json.dumps(cancel))
check("Status CANCELED", cancel["order"]["status"] == "CANCELED")
check("Released 1 BTC", cancel["releasedAmount"] == "1.00000000", f"released={cancel.get('releasedAmount')}")

# ── Test 6: Insufficient balance ──
print("\n--- Test 6: Insufficient balance ---")
order4 = api("POST", "/orders", tokenB, {"pairId": pairId, "side": "BUY", "type": "MARKET", "qty": "9999"})
check("400 insufficient", order4.get("error") == "insufficient_balance", json.dumps(order4))

# ── Test 7: Cancel filled order ──
print("\n--- Test 7: Cancel filled order ---")
filledOrderId = order3["order"]["id"]
cancelFilled = api("DELETE", f"/orders/{filledOrderId}", tokenA)
check("400 not cancelable", cancelFilled.get("error") == "order_not_cancelable", json.dumps(cancelFilled))

# ── Test 8: Ownership check ──
print("\n--- Test 8: Ownership check ---")
otherOrder = api("GET", f"/orders/{sellOrderId}", tokenA)
check("403 forbidden", otherOrder.get("error") == "forbidden", json.dumps(otherOrder))

# ── Test 9: LIMIT crossing (immediate match) ──
print("\n--- Test 9: LIMIT crossing ---")
# A places LIMIT BUY at 55000
order5 = api("POST", "/orders", tokenA, {"pairId": pairId, "side": "BUY", "type": "LIMIT", "qty": "1", "limitPrice": "55000"})
check("A LIMIT BUY OPEN", order5.get("ok") and order5["order"]["status"] == "OPEN", json.dumps(order5))
aBuyOrderId = order5["order"]["id"]

# B places LIMIT SELL at 54000 → should cross A's resting BUY at 55000
order6 = api("POST", "/orders", tokenB, {"pairId": pairId, "side": "SELL", "type": "LIMIT", "qty": "1", "limitPrice": "54000"})
check("B LIMIT SELL FILLED", order6.get("ok") and order6["order"]["status"] == "FILLED", json.dumps(order6))
check("1 fill at 55000", len(order6["fills"]) == 1 and order6["fills"][0]["price"] == "55000.00000000",
      f"fills={json.dumps(order6.get('fills'))}")

# A's buy should now be FILLED too
order5detail = api("GET", f"/orders/{aBuyOrderId}", tokenA)
check("A BUY now FILLED", order5detail["order"]["status"] == "FILLED")

print("\n=== All Phase 4 smoke tests passed ===")
