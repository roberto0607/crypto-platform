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

describe("Price-time priority — deterministic matching", () => {
  // Independent fixtures for this suite: a seller (maker) and buyer (taker)
  let sellerToken: string;
  let buyerToken: string;
  let ptPairId: string;
  const ptUid = Math.random().toString(36).slice(2, 7);

  beforeAll(async () => {
    const pool = getPool();

    // Create seller & buyer users
    const seller = await registerAndLogin(app, "seller");
    sellerToken = seller.accessToken;

    const buyer = await registerAndLogin(app, "buyer");
    buyerToken = buyer.accessToken;

    // Create assets
    const btcRes = await app.inject({
      method: "POST",
      url: "/admin/assets",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { symbol: `X${ptUid}`, name: "BTC-PT", decimals: 8 },
    });
    const ptBaseId = btcRes.json().asset.id;

    const usdRes = await app.inject({
      method: "POST",
      url: "/admin/assets",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { symbol: `Y${ptUid}`, name: "USD-PT", decimals: 2 },
    });
    const ptQuoteId = usdRes.json().asset.id;

    // Create pair (0 fee to simplify assertions)
    const pairRes = await app.inject({
      method: "POST",
      url: "/admin/pairs",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { baseAssetId: ptBaseId, quoteAssetId: ptQuoteId, symbol: `T${ptUid}`, feeBps: 0 },
    });
    ptPairId = pairRes.json().pair.id;

    // Set last price (required for MARKET orders, also useful as reference)
    await app.inject({
      method: "PATCH",
      url: `/admin/pairs/${ptPairId}/price`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { price: "50000" },
    });

    // Create wallets and fund both users
    for (const { token, base, quote } of [
      { token: sellerToken, base: "100", quote: "0" },
      { token: buyerToken, base: "0", quote: "10000000" },
    ]) {
      const bw = await app.inject({
        method: "POST", url: "/wallets",
        headers: { authorization: `Bearer ${token}` },
        payload: { assetId: ptBaseId },
      });
      const qw = await app.inject({
        method: "POST", url: "/wallets",
        headers: { authorization: `Bearer ${token}` },
        payload: { assetId: ptQuoteId },
      });

      if (parseFloat(base) > 0) {
        await app.inject({
          method: "POST",
          url: `/admin/wallets/${bw.json().wallet.id}/credit`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { amount: base },
        });
      }
      if (parseFloat(quote) > 0) {
        await app.inject({
          method: "POST",
          url: `/admin/wallets/${qw.json().wallet.id}/credit`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { amount: quote },
        });
      }
    }
  });

  it("matches SELL orders cheapest-first, then oldest-first at same price", async () => {
    // Seller places 3 LIMIT SELL orders in this chronological order:
    //   A: 1 BTC @ $48000  (placed first)
    //   B: 1 BTC @ $47000  (cheapest — should match first)
    //   C: 1 BTC @ $48000  (placed third, same price as A — should match after A)

    const orderA = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${sellerToken}` },
      payload: { pairId: ptPairId, side: "SELL", type: "LIMIT", qty: "1", limitPrice: "48000" },
    });
    expect(orderA.statusCode).toBe(201);
    const orderAId = orderA.json().order.id;

    const orderB = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${sellerToken}` },
      payload: { pairId: ptPairId, side: "SELL", type: "LIMIT", qty: "1", limitPrice: "47000" },
    });
    expect(orderB.statusCode).toBe(201);
    const orderBId = orderB.json().order.id;

    const orderC = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${sellerToken}` },
      payload: { pairId: ptPairId, side: "SELL", type: "LIMIT", qty: "1", limitPrice: "48000" },
    });
    expect(orderC.statusCode).toBe(201);
    const orderCId = orderC.json().order.id;

    // Buyer places LIMIT BUY for 2.5 BTC @ $48000
    // Should match: B (1@47k) → A (1@48k) → C (0.5@48k)
    const buyRes = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${buyerToken}` },
      payload: { pairId: ptPairId, side: "BUY", type: "LIMIT", qty: "2.5", limitPrice: "48000" },
    });
    expect(buyRes.statusCode).toBe(201);
    const { order: buyOrder, fills } = buyRes.json();

    // 3 fills in price-time priority order
    expect(fills).toHaveLength(3);

    // Fill 1: Order B @ $47000 — cheapest
    expect(fills[0].price).toBe("47000.00000000");
    expect(fills[0].qty).toBe("1.00000000");
    expect(fills[0].sell_order_id).toBe(orderBId);

    // Fill 2: Order A @ $48000 — older of the two $48k orders
    expect(fills[1].price).toBe("48000.00000000");
    expect(fills[1].qty).toBe("1.00000000");
    expect(fills[1].sell_order_id).toBe(orderAId);

    // Fill 3: Order C @ $48000 — partial fill (0.5 BTC remaining)
    expect(fills[2].price).toBe("48000.00000000");
    expect(fills[2].qty).toBe("0.50000000");
    expect(fills[2].sell_order_id).toBe(orderCId);

    // Buy order should be FILLED (2.5 total)
    expect(buyOrder.status).toBe("FILLED");
    expect(buyOrder.qty_filled).toBe("2.50000000");

    // Verify maker order states
    const orderBState = await app.inject({
      method: "GET", url: `/orders/${orderBId}`,
      headers: { authorization: `Bearer ${sellerToken}` },
    });
    expect(orderBState.json().order.status).toBe("FILLED");

    const orderAState = await app.inject({
      method: "GET", url: `/orders/${orderAId}`,
      headers: { authorization: `Bearer ${sellerToken}` },
    });
    expect(orderAState.json().order.status).toBe("FILLED");

    const orderCState = await app.inject({
      method: "GET", url: `/orders/${orderCId}`,
      headers: { authorization: `Bearer ${sellerToken}` },
    });
    expect(orderCState.json().order.status).toBe("PARTIALLY_FILLED");
    expect(orderCState.json().order.qty_filled).toBe("0.50000000");
  });

  it("matches BUY orders most-expensive-first, then oldest-first at same price", async () => {
    // Buyer places 3 LIMIT BUY orders:
    //   D: 1 BTC @ $46000  (placed first)
    //   E: 1 BTC @ $46500  (most expensive — should match first)
    //   F: 1 BTC @ $46000  (placed third, same price as D — should match after D)

    const orderD = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${buyerToken}` },
      payload: { pairId: ptPairId, side: "BUY", type: "LIMIT", qty: "1", limitPrice: "46000" },
    });
    expect(orderD.statusCode).toBe(201);
    const orderDId = orderD.json().order.id;

    const orderE = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${buyerToken}` },
      payload: { pairId: ptPairId, side: "BUY", type: "LIMIT", qty: "1", limitPrice: "46500" },
    });
    expect(orderE.statusCode).toBe(201);
    const orderEId = orderE.json().order.id;

    const orderF = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${buyerToken}` },
      payload: { pairId: ptPairId, side: "BUY", type: "LIMIT", qty: "1", limitPrice: "46000" },
    });
    expect(orderF.statusCode).toBe(201);
    const orderFId = orderF.json().order.id;

    // Seller places LIMIT SELL for 2.5 BTC @ $46000
    // Should match: E (1@46.5k) → D (1@46k) → F (0.5@46k)
    const sellRes = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${sellerToken}` },
      payload: { pairId: ptPairId, side: "SELL", type: "LIMIT", qty: "2.5", limitPrice: "46000" },
    });
    expect(sellRes.statusCode).toBe(201);
    const { order: sellOrder, fills } = sellRes.json();

    // 3 fills in price-time priority order
    expect(fills).toHaveLength(3);

    // Fill 1: Order E @ $46500 — most expensive
    expect(fills[0].price).toBe("46500.00000000");
    expect(fills[0].qty).toBe("1.00000000");
    expect(fills[0].buy_order_id).toBe(orderEId);

    // Fill 2: Order D @ $46000 — older of the two $46k orders
    expect(fills[1].price).toBe("46000.00000000");
    expect(fills[1].qty).toBe("1.00000000");
    expect(fills[1].buy_order_id).toBe(orderDId);

    // Fill 3: Order F @ $46000 — partial fill (0.5 BTC remaining)
    expect(fills[2].price).toBe("46000.00000000");
    expect(fills[2].qty).toBe("0.50000000");
    expect(fills[2].buy_order_id).toBe(orderFId);

    // Sell order should be FILLED (2.5 total)
    expect(sellOrder.status).toBe("FILLED");
    expect(sellOrder.qty_filled).toBe("2.50000000");
  });
});

describe("Self-trade prevention", () => {
  let stpToken: string;
  let stpPairId: string;
  const stpUid = Math.random().toString(36).slice(2, 7);

  beforeAll(async () => {
    // Single user who will try to trade against themselves
    const user = await registerAndLogin(app, "stp-user");
    stpToken = user.accessToken;

    // Create assets + pair (0 fee)
    const btcRes = await app.inject({
      method: "POST", url: "/admin/assets",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { symbol: `S${stpUid}`, name: "BTC-STP", decimals: 8 },
    });
    const stpBaseId = btcRes.json().asset.id;

    const usdRes = await app.inject({
      method: "POST", url: "/admin/assets",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { symbol: `D${stpUid}`, name: "USD-STP", decimals: 2 },
    });
    const stpQuoteId = usdRes.json().asset.id;

    const pairRes = await app.inject({
      method: "POST", url: "/admin/pairs",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { baseAssetId: stpBaseId, quoteAssetId: stpQuoteId, symbol: `Q${stpUid}`, feeBps: 0 },
    });
    stpPairId = pairRes.json().pair.id;

    await app.inject({
      method: "PATCH",
      url: `/admin/pairs/${stpPairId}/price`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { price: "50000" },
    });

    // Create + fund wallets for the user
    const bw = await app.inject({
      method: "POST", url: "/wallets",
      headers: { authorization: `Bearer ${stpToken}` },
      payload: { assetId: stpBaseId },
    });
    const qw = await app.inject({
      method: "POST", url: "/wallets",
      headers: { authorization: `Bearer ${stpToken}` },
      payload: { assetId: stpQuoteId },
    });

    await app.inject({
      method: "POST",
      url: `/admin/wallets/${bw.json().wallet.id}/credit`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { amount: "100" },
    });
    await app.inject({
      method: "POST",
      url: `/admin/wallets/${qw.json().wallet.id}/credit`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { amount: "10000000" },
    });
  });

  it("MARKET BUY does not match user's own LIMIT SELL — system-fills instead", async () => {
    // User places LIMIT SELL
    const sellRes = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${stpToken}` },
      payload: { pairId: stpPairId, side: "SELL", type: "LIMIT", qty: "1", limitPrice: "49000" },
    });
    expect(sellRes.statusCode).toBe(201);
    const sellOrder = sellRes.json().order;
    expect(sellOrder.status).toBe("OPEN");

    // Same user places MARKET BUY — should NOT match the LIMIT SELL
    const buyRes = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${stpToken}` },
      payload: { pairId: stpPairId, side: "BUY", type: "MARKET", qty: "1" },
    });
    expect(buyRes.statusCode).toBe(201);
    const { order: buyOrder, fills } = buyRes.json();

    // Should get a system-fill (no book match against own order)
    expect(fills).toHaveLength(1);
    expect(fills[0].is_system_fill).toBe(true);

    // Buy order is FILLED via system fill
    expect(buyOrder.status).toBe("FILLED");

    // The original LIMIT SELL should still be OPEN (not matched)
    const sellState = await app.inject({
      method: "GET", url: `/orders/${sellOrder.id}`,
      headers: { authorization: `Bearer ${stpToken}` },
    });
    expect(sellState.json().order.status).toBe("OPEN");
    expect(sellState.json().order.qty_filled).toBe("0.00000000");
  });

  it("LIMIT BUY does not match user's own LIMIT SELL — rests on book", async () => {
    // User places LIMIT SELL
    const sellRes = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${stpToken}` },
      payload: { pairId: stpPairId, side: "SELL", type: "LIMIT", qty: "1", limitPrice: "48000" },
    });
    expect(sellRes.statusCode).toBe(201);
    const sellOrder = sellRes.json().order;

    // Same user places crossing LIMIT BUY — should NOT match
    const buyRes = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${stpToken}` },
      payload: { pairId: stpPairId, side: "BUY", type: "LIMIT", qty: "1", limitPrice: "48000" },
    });
    expect(buyRes.statusCode).toBe(201);
    const { order: buyOrder, fills } = buyRes.json();

    // No fills — buy order rests on the book
    expect(fills).toHaveLength(0);
    expect(buyOrder.status).toBe("OPEN");
    expect(buyOrder.qty_filled).toBe("0.00000000");

    // Sell order still untouched
    const sellState = await app.inject({
      method: "GET", url: `/orders/${sellOrder.id}`,
      headers: { authorization: `Bearer ${stpToken}` },
    });
    expect(sellState.json().order.status).toBe("OPEN");
    expect(sellState.json().order.qty_filled).toBe("0.00000000");

    // Cleanup: cancel both orders to release reserves
    await app.inject({ method: "DELETE", url: `/orders/${sellOrder.id}`, headers: { authorization: `Bearer ${stpToken}` } });
    await app.inject({ method: "DELETE", url: `/orders/${buyOrder.id}`, headers: { authorization: `Bearer ${stpToken}` } });
  });
});

describe("Financial integrity — precision & invariants", () => {
  // Uses a pair with real fees (30 bps) to exercise invariant checks
  let makerToken: string;
  let takerToken: string;
  let fiPairId: string;
  let fiBaseId: string;
  let fiQuoteId: string;
  const fiUid = Math.random().toString(36).slice(2, 7);

  /** Helper: get wallet for a token+asset */
  async function walletFor(token: string, assetId: string) {
    const res = await app.inject({
      method: "GET", url: "/wallets",
      headers: { authorization: `Bearer ${token}` },
    });
    return (res.json().wallets as Array<{ id: string; asset_id: string; balance: string; reserved: string }>)
      .find((w) => w.asset_id === assetId)!;
  }

  beforeAll(async () => {
    const maker = await registerAndLogin(app, "fi-maker");
    makerToken = maker.accessToken;
    const taker = await registerAndLogin(app, "fi-taker");
    takerToken = taker.accessToken;

    // Assets
    const btcRes = await app.inject({
      method: "POST", url: "/admin/assets",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { symbol: `F${fiUid}`, name: "BTC-FI", decimals: 8 },
    });
    fiBaseId = btcRes.json().asset.id;

    const usdRes = await app.inject({
      method: "POST", url: "/admin/assets",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { symbol: `G${fiUid}`, name: "USD-FI", decimals: 2 },
    });
    fiQuoteId = usdRes.json().asset.id;

    // Pair with 30 bps fee
    const pairRes = await app.inject({
      method: "POST", url: "/admin/pairs",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { baseAssetId: fiBaseId, quoteAssetId: fiQuoteId, symbol: `H${fiUid}`, feeBps: 30 },
    });
    fiPairId = pairRes.json().pair.id;

    await app.inject({
      method: "PATCH", url: `/admin/pairs/${fiPairId}/price`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { price: "50000" },
    });

    // Create + fund wallets for both users
    for (const { token, base, quote } of [
      { token: makerToken, base: "1000", quote: "100000000" },
      { token: takerToken, base: "1000", quote: "100000000" },
    ]) {
      const bw = await app.inject({
        method: "POST", url: "/wallets",
        headers: { authorization: `Bearer ${token}` },
        payload: { assetId: fiBaseId },
      });
      const qw = await app.inject({
        method: "POST", url: "/wallets",
        headers: { authorization: `Bearer ${token}` },
        payload: { assetId: fiQuoteId },
      });
      await app.inject({
        method: "POST", url: `/admin/wallets/${bw.json().wallet.id}/credit`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { amount: base },
      });
      await app.inject({
        method: "POST", url: `/admin/wallets/${qw.json().wallet.id}/credit`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { amount: quote },
      });
    }
  });

  it("8-decimal precision trade: invariants pass, balances correct", async () => {
    // Maker SELL: 0.00000001 BTC (1 satoshi) @ $99999.99999999
    const sellRes = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${makerToken}` },
      payload: { pairId: fiPairId, side: "SELL", type: "LIMIT", qty: "0.00000001", limitPrice: "99999.99999999" },
    });
    expect(sellRes.statusCode).toBe(201);

    // Taker BUY: matches at edge precision
    const buyRes = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${takerToken}` },
      payload: { pairId: fiPairId, side: "BUY", type: "LIMIT", qty: "0.00000001", limitPrice: "99999.99999999" },
    });
    expect(buyRes.statusCode).toBe(201);
    const { order, fills } = buyRes.json();

    // Should match — invariant checks run inside the transaction
    expect(fills).toHaveLength(1);
    expect(order.status).toBe("FILLED");
    expect(fills[0].qty).toBe("0.00000001");
    expect(fills[0].price).toBe("99999.99999999");

    // Wallet balances should remain non-negative
    const takerBase = await walletFor(takerToken, fiBaseId);
    const takerQuote = await walletFor(takerToken, fiQuoteId);
    expect(parseFloat(takerBase.balance)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(takerQuote.balance)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(takerBase.reserved)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(takerQuote.reserved)).toBeGreaterThanOrEqual(0);
  });

  it("high-value trade with fees: debit/credit balance holds", async () => {
    // Capture balances before
    const makerBaseBefore = await walletFor(makerToken, fiBaseId);
    const makerQuoteBefore = await walletFor(makerToken, fiQuoteId);
    const takerBaseBefore = await walletFor(takerToken, fiBaseId);
    const takerQuoteBefore = await walletFor(takerToken, fiQuoteId);

    // Maker SELL: 10 BTC @ $50000 (quote = 500,000; fee = 500,000 * 30/10000 = 1500)
    const sellRes = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${makerToken}` },
      payload: { pairId: fiPairId, side: "SELL", type: "LIMIT", qty: "10", limitPrice: "50000" },
    });
    expect(sellRes.statusCode).toBe(201);

    // Taker BUY: 10 BTC @ $50000
    const buyRes = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${takerToken}` },
      payload: { pairId: fiPairId, side: "BUY", type: "LIMIT", qty: "10", limitPrice: "50000" },
    });
    expect(buyRes.statusCode).toBe(201);
    const { order, fills } = buyRes.json();

    expect(fills).toHaveLength(1);
    expect(order.status).toBe("FILLED");

    // Verify trade amounts
    const fill = fills[0];
    expect(fill.qty).toBe("10.00000000");
    expect(fill.price).toBe("50000.00000000");
    expect(fill.quote_amount).toBe("500000.00000000");
    expect(fill.fee_amount).toBe("1500.00000000");

    // Verify balance changes
    const makerBaseAfter = await walletFor(makerToken, fiBaseId);
    const makerQuoteAfter = await walletFor(makerToken, fiQuoteId);
    const takerBaseAfter = await walletFor(takerToken, fiBaseId);
    const takerQuoteAfter = await walletFor(takerToken, fiQuoteId);

    // Maker (seller): -10 base, +500000 quote
    const makerBaseDelta = parseFloat(makerBaseAfter.balance) - parseFloat(makerBaseBefore.balance);
    const makerQuoteDelta = parseFloat(makerQuoteAfter.balance) - parseFloat(makerQuoteBefore.balance);
    expect(makerBaseDelta).toBeCloseTo(-10, 8);
    expect(makerQuoteDelta).toBeCloseTo(500000, 2);

    // Taker (buyer): +10 base, -(500000 + 1500) quote
    const takerBaseDelta = parseFloat(takerBaseAfter.balance) - parseFloat(takerBaseBefore.balance);
    const takerQuoteDelta = parseFloat(takerQuoteAfter.balance) - parseFloat(takerQuoteBefore.balance);
    expect(takerBaseDelta).toBeCloseTo(10, 8);
    expect(takerQuoteDelta).toBeCloseTo(-501500, 2);

    // System-wide: base net = 0, quote net = -fee
    expect(makerBaseDelta + takerBaseDelta).toBeCloseTo(0, 8);
    expect(makerQuoteDelta + takerQuoteDelta).toBeCloseTo(-1500, 2);

    // All wallets non-negative
    for (const w of [makerBaseAfter, makerQuoteAfter, takerBaseAfter, takerQuoteAfter]) {
      expect(parseFloat(w.balance)).toBeGreaterThanOrEqual(0);
      expect(parseFloat(w.reserved)).toBeGreaterThanOrEqual(0);
    }
  });

  it("partial fill at 8-decimal precision preserves invariants", async () => {
    // Maker SELL: 0.12345678 BTC @ $67890.12345678
    const sellRes = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${makerToken}` },
      payload: { pairId: fiPairId, side: "SELL", type: "LIMIT", qty: "0.12345678", limitPrice: "67890.12345678" },
    });
    expect(sellRes.statusCode).toBe(201);
    const sellOrderId = sellRes.json().order.id;

    // Taker BUY: only 0.05000000 BTC (partial fill)
    const buyRes = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${takerToken}` },
      payload: { pairId: fiPairId, side: "BUY", type: "LIMIT", qty: "0.05000000", limitPrice: "67890.12345678" },
    });
    expect(buyRes.statusCode).toBe(201);
    const { order: buyOrder, fills } = buyRes.json();

    // Transaction succeeded (invariants passed inside)
    expect(fills).toHaveLength(1);
    expect(buyOrder.status).toBe("FILLED");
    expect(fills[0].qty).toBe("0.05000000");

    // Maker order partially filled
    const sellState = await app.inject({
      method: "GET", url: `/orders/${sellOrderId}`,
      headers: { authorization: `Bearer ${makerToken}` },
    });
    const makerOrder = sellState.json().order;
    expect(makerOrder.status).toBe("PARTIALLY_FILLED");
    expect(makerOrder.qty_filled).toBe("0.05000000");

    // reserved_consumed <= reserved_amount
    expect(parseFloat(makerOrder.reserved_consumed)).toBeLessThanOrEqual(
      parseFloat(makerOrder.reserved_amount),
    );

    // All wallets remain non-negative
    for (const token of [makerToken, takerToken]) {
      const base = await walletFor(token, fiBaseId);
      const quote = await walletFor(token, fiQuoteId);
      expect(parseFloat(base.balance)).toBeGreaterThanOrEqual(0);
      expect(parseFloat(quote.balance)).toBeGreaterThanOrEqual(0);
      expect(parseFloat(base.reserved)).toBeGreaterThanOrEqual(0);
      expect(parseFloat(quote.reserved)).toBeGreaterThanOrEqual(0);
    }

    // Cleanup: cancel the remaining maker order
    await app.inject({
      method: "DELETE", url: `/orders/${sellOrderId}`,
      headers: { authorization: `Bearer ${makerToken}` },
    });
  });
});
