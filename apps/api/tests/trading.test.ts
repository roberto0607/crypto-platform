import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, registerAndLogin, getPool } from "./helpers";

let app: FastifyInstance;

// Shared state for the trading test suite
let adminToken: string;
let traderToken: string;
let traderId: string;
let pairId: string;
let baseAssetId: string;   // e.g. BTC
let quoteAssetId: string;  // e.g. USD
let traderBaseWalletId: string;
let traderQuoteWalletId: string;

// Short unique suffix for test asset/pair symbols (max 10 chars total)
const uid = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
  app = await getTestApp();
  const pool = getPool();

  // 1. Register an admin user (promote via direct DB update)
  const admin = await registerAndLogin(app, "trade-admin");
  await pool.query(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [admin.userId]);
  // Re-login to get token with ADMIN role
  const adminLoginRes = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: admin.email, password: admin.password },
  });
  adminToken = adminLoginRes.json().accessToken;

  // 2. Register a trader user
  const trader = await registerAndLogin(app, "trader");
  traderToken = trader.accessToken;
  traderId = trader.userId;

  // 3. Create assets (BTC + USD)
  const btcRes = await app.inject({
    method: "POST",
    url: "/admin/assets",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { symbol: `B${uid}`, name: "Bitcoin Test", decimals: 8 },
  });
  const btcBody = btcRes.json();
  if (!btcBody.asset) throw new Error(`Asset creation failed: ${JSON.stringify(btcBody)}`);
  baseAssetId = btcBody.asset.id;

  const usdRes = await app.inject({
    method: "POST",
    url: "/admin/assets",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { symbol: `U${uid}`, name: "Dollar Test", decimals: 2 },
  });
  const usdBody = usdRes.json();
  if (!usdBody.asset) throw new Error(`Asset creation failed: ${JSON.stringify(usdBody)}`);
  quoteAssetId = usdBody.asset.id;

  // 4. Create trading pair
  const pairRes = await app.inject({
    method: "POST",
    url: "/admin/pairs",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { baseAssetId, quoteAssetId, symbol: `P${uid}`, feeBps: 0 },
  });
  pairId = pairRes.json().pair.id;

  // 5. Set last price on the pair (needed for MARKET orders)
  await app.inject({
    method: "PATCH",
    url: `/admin/pairs/${pairId}/price`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { price: "50000" },
  });

  // 6. Create wallets for trader
  const baseWalletRes = await app.inject({
    method: "POST",
    url: "/wallets",
    headers: { authorization: `Bearer ${traderToken}` },
    payload: { assetId: baseAssetId },
  });
  traderBaseWalletId = baseWalletRes.json().wallet.id;

  const quoteWalletRes = await app.inject({
    method: "POST",
    url: "/wallets",
    headers: { authorization: `Bearer ${traderToken}` },
    payload: { assetId: quoteAssetId },
  });
  traderQuoteWalletId = quoteWalletRes.json().wallet.id;

  // 7. Credit wallets via admin
  await app.inject({
    method: "POST",
    url: `/admin/wallets/${traderBaseWalletId}/credit`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { amount: "10" },   // 10 BTC
  });

  await app.inject({
    method: "POST",
    url: `/admin/wallets/${traderQuoteWalletId}/credit`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { amount: "1000000" },  // 1M USD
  });
});

afterAll(async () => {
  await closeTestApp();
});

/** Helper: get wallet balance + reserved from GET /wallets */
async function getWalletState(walletId: string) {
  const res = await app.inject({
    method: "GET",
    url: "/wallets",
    headers: { authorization: `Bearer ${traderToken}` },
  });
  const wallets = res.json().wallets as Array<{ id: string; balance: string; reserved: string }>;
  return wallets.find((w) => w.id === walletId)!;
}

describe("LIMIT order — reserve on creation, release on cancel", () => {
  it("reserves quote funds when placing a LIMIT BUY", async () => {
    const walletBefore = await getWalletState(traderQuoteWalletId);

    // Place LIMIT BUY: 1 BTC at $45000
    const orderRes = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${traderToken}` },
      payload: { pairId, side: "BUY", type: "LIMIT", qty: "1", limitPrice: "45000" },
    });

    expect(orderRes.statusCode).toBe(201);
    const { order } = orderRes.json();
    expect(order.status).toBe("OPEN");
    expect(parseFloat(order.reserved_amount)).toBe(45000);

    // Wallet reserved should increase by 45000
    const walletAfter = await getWalletState(traderQuoteWalletId);
    const reservedDiff = parseFloat(walletAfter.reserved) - parseFloat(walletBefore.reserved);
    expect(reservedDiff).toBeCloseTo(45000, 2);

    // Cancel the order — reserved should be released
    const cancelRes = await app.inject({
      method: "DELETE",
      url: `/orders/${order.id}`,
      headers: { authorization: `Bearer ${traderToken}` },
    });

    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json().ok).toBe(true);

    const walletFinal = await getWalletState(traderQuoteWalletId);
    expect(parseFloat(walletFinal.reserved)).toBeCloseTo(parseFloat(walletBefore.reserved), 2);
  });

  it("reserves base funds when placing a LIMIT SELL", async () => {
    const walletBefore = await getWalletState(traderBaseWalletId);

    // Place LIMIT SELL: 2 BTC at $55000
    const orderRes = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${traderToken}` },
      payload: { pairId, side: "SELL", type: "LIMIT", qty: "2", limitPrice: "55000" },
    });

    expect(orderRes.statusCode).toBe(201);
    const { order } = orderRes.json();
    expect(order.status).toBe("OPEN");
    expect(parseFloat(order.reserved_amount)).toBe(2);

    // Wallet reserved should increase by 2
    const walletAfter = await getWalletState(traderBaseWalletId);
    const reservedDiff = parseFloat(walletAfter.reserved) - parseFloat(walletBefore.reserved);
    expect(reservedDiff).toBeCloseTo(2, 8);

    // Cancel
    await app.inject({
      method: "DELETE",
      url: `/orders/${order.id}`,
      headers: { authorization: `Bearer ${traderToken}` },
    });

    const walletFinal = await getWalletState(traderBaseWalletId);
    expect(parseFloat(walletFinal.reserved)).toBeCloseTo(parseFloat(walletBefore.reserved), 8);
  });
});

describe("MARKET order — does NOT reserve", () => {
  it("MARKET BUY does not increase reserved on quote wallet", async () => {
    const walletBefore = await getWalletState(traderQuoteWalletId);

    // Place MARKET BUY: 0.01 BTC (small amount, will system-fill at last_price)
    const orderRes = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${traderToken}` },
      payload: { pairId, side: "BUY", type: "MARKET", qty: "0.01" },
    });

    expect(orderRes.statusCode).toBe(201);
    const { order } = orderRes.json();

    // MARKET orders should not have reserved funds
    expect(parseFloat(order.reserved_amount)).toBe(0);

    // Wallet reserved should not have increased
    const walletAfter = await getWalletState(traderQuoteWalletId);
    expect(parseFloat(walletAfter.reserved)).toBeCloseTo(parseFloat(walletBefore.reserved), 2);
  });
});
