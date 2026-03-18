/**
 * Concurrency / race condition stress tests.
 *
 * Uses Promise.all with app.inject to fire concurrent HTTP requests.
 * The pg pool dispatches them across real database connections, so
 * pair-level and wallet-level locks are exercised under contention.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, registerAndLogin, getPool } from "./helpers";

let app: FastifyInstance;
let adminToken: string;

type PairCtx = { pairId: string; baseId: string; quoteId: string };

type UserCtx = {
  token: string;
  userId: string;
  baseWalletId: string;
  quoteWalletId: string;
};

beforeAll(async () => {
  app = await getTestApp();
  const pool = getPool();

  // Admin
  const admin = await registerAndLogin(app, "cc-admin");
  await pool.query(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [admin.userId]);
  const adminLogin = await app.inject({
    method: "POST", url: "/auth/login",
    payload: { email: admin.email, password: admin.password },
  });
  adminToken = adminLogin.json().accessToken;
});

afterAll(async () => {
  await closeTestApp();
});

/** Create a fresh pair with its own unique assets (0 fee). */
async function createPair(): Promise<PairCtx> {
  const uid = Math.random().toString(36).slice(2, 7);

  const btcRes = await app.inject({
    method: "POST", url: "/admin/assets",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { symbol: `B${uid}`, name: `BTC-${uid}`, decimals: 8 },
  });
  const baseId = btcRes.json().asset.id;

  const usdRes = await app.inject({
    method: "POST", url: "/admin/assets",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { symbol: `U${uid}`, name: `USD-${uid}`, decimals: 2 },
  });
  const quoteId = usdRes.json().asset.id;

  const pairRes = await app.inject({
    method: "POST", url: "/admin/pairs",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { baseAssetId: baseId, quoteAssetId: quoteId, symbol: `P${uid}`, feeBps: 0 },
  });
  const pairId = pairRes.json().pair.id;

  await app.inject({
    method: "PATCH", url: `/admin/pairs/${pairId}/price`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { price: "50000" },
  });

  return { pairId, baseId, quoteId };
}

/** Find (or create) a wallet for a given asset — handles auto-wallet races. */
async function getOrCreateWallet(token: string, assetId: string): Promise<string> {
  const createRes = await app.inject({
    method: "POST", url: "/wallets",
    headers: { authorization: `Bearer ${token}` },
    payload: { assetId },
  });
  if (createRes.json().wallet) return createRes.json().wallet.id;

  const listRes = await app.inject({
    method: "GET", url: "/wallets",
    headers: { authorization: `Bearer ${token}` },
  });
  const wallets = listRes.json().wallets as Array<{ id: string; asset_id: string }>;
  return wallets.find((w) => w.asset_id === assetId)!.id;
}

/** Create a user with funded wallets for a specific pair's assets. */
async function createFundedUser(
  prefix: string, pair: PairCtx, base: string, quote: string,
): Promise<UserCtx> {
  const user = await registerAndLogin(app, prefix);

  const baseWalletId = await getOrCreateWallet(user.accessToken, pair.baseId);
  const quoteWalletId = await getOrCreateWallet(user.accessToken, pair.quoteId);

  if (parseFloat(base) > 0) {
    await app.inject({
      method: "POST", url: `/admin/wallets/${baseWalletId}/credit`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { amount: base },
    });
  }
  if (parseFloat(quote) > 0) {
    await app.inject({
      method: "POST", url: `/admin/wallets/${quoteWalletId}/credit`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { amount: quote },
    });
  }

  return { token: user.accessToken, userId: user.userId, baseWalletId, quoteWalletId };
}

/** Verify global invariants for a set of users. */
async function verifyInvariants(userIds: string[]) {
  const pool = getPool();

  // No negative balance, no negative reserved, reserved <= balance
  const badWallets = await pool.query(
    `SELECT id, balance::text, reserved::text
     FROM wallets
     WHERE user_id = ANY($1)
       AND (balance < 0 OR reserved < 0 OR reserved > balance)`,
    [userIds],
  );
  expect(badWallets.rows).toHaveLength(0);

  // No order over-consumed
  const badOrders = await pool.query(
    `SELECT id, reserved_amount::text, reserved_consumed::text
     FROM orders
     WHERE user_id = ANY($1)
       AND reserved_consumed > reserved_amount`,
    [userIds],
  );
  expect(badOrders.rows).toHaveLength(0);
}

// ─────────────────────────────────────────────────────────
// Test suite 1: 10 concurrent LIMIT orders
// ─────────────────────────────────────────────────────────

describe("Concurrency — 10 concurrent LIMIT orders", () => {
  it("no deadlocks, no duplicate fills, balances consistent", async () => {
    const pair = await createPair();

    // 5 sellers (10 BTC each + USD margin), 5 buyers (1M USD each)
    const sellers = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createFundedUser(`cc-ls-${i}`, pair, "10", "10000000")),
    );
    const buyers = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createFundedUser(`cc-lb-${i}`, pair, "0", "1000000")),
    );

    // Fire all 10 LIMIT orders concurrently (crossing price — all should match)
    const results = await Promise.all([
      ...sellers.map((s) =>
        app.inject({
          method: "POST", url: "/orders",
          headers: { authorization: `Bearer ${s.token}` },
          payload: { pairId: pair.pairId, side: "SELL", type: "LIMIT", qty: "1", limitPrice: "50000" },
        }),
      ),
      ...buyers.map((b) =>
        app.inject({
          method: "POST", url: "/orders",
          headers: { authorization: `Bearer ${b.token}` },
          payload: { pairId: pair.pairId, side: "BUY", type: "LIMIT", qty: "1", limitPrice: "50000" },
        }),
      ),
    ]);

    // All should succeed
    for (const res of results) {
      expect(res.statusCode).toBe(201);
    }

    // No duplicate fill IDs
    const allFills = results.flatMap(
      (r) => r.json().fills as Array<{ id: string }>,
    );
    const fillIds = allFills.map((f) => f.id);
    expect(new Set(fillIds).size).toBe(fillIds.length);

    // Verify financial invariants
    const allUserIds = [...sellers, ...buyers].map((u) => u.userId);
    await verifyInvariants(allUserIds);

    // Conservation: total base across all users = initial 50 (5 sellers * 10)
    const pool = getPool();
    const baseSum = await pool.query<{ total: string }>(
      `SELECT SUM(balance)::text AS total FROM wallets
       WHERE asset_id = $1 AND user_id = ANY($2)`,
      [pair.baseId, allUserIds],
    );
    expect(parseFloat(baseSum.rows[0].total)).toBeCloseTo(50, 4);
  });
});

// ─────────────────────────────────────────────────────────
// Test suite 2: 10 concurrent MARKET orders against resting book
// ─────────────────────────────────────────────────────────

describe("Concurrency — 10 concurrent MARKET orders", () => {
  it("no double-fills of resting orders, no negative balances", { timeout: 15000 }, async () => {
    const pair = await createPair();

    // Maker: place 10 resting LIMIT SELL (1 BTC each @ 50000)
    const maker = await createFundedUser("cc-maker", pair, "100", "10000000");
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "POST", url: "/orders",
        headers: { authorization: `Bearer ${maker.token}` },
        payload: { pairId: pair.pairId, side: "SELL", type: "LIMIT", qty: "1", limitPrice: "50000" },
      });
      expect(res.statusCode).toBe(201);
    }

    // 10 takers fire MARKET BUY for 1 BTC concurrently
    const takers = await Promise.all(
      Array.from({ length: 10 }, (_, i) => createFundedUser(`cc-mt-${i}`, pair, "0", "1000000")),
    );

    const results = await Promise.all(
      takers.map((t) =>
        app.inject({
          method: "POST", url: "/orders",
          headers: { authorization: `Bearer ${t.token}` },
          payload: { pairId: pair.pairId, side: "BUY", type: "MARKET", qty: "1" },
        }),
      ),
    );

    for (const res of results) {
      expect(res.statusCode).toBe(201);
    }

    // Count non-system book fills — each resting order matched at most once
    const bookFills = results.flatMap((r) =>
      (r.json().fills as Array<{ id: string; is_system_fill: boolean }>)
        .filter((f) => !f.is_system_fill),
    );
    expect(bookFills.length).toBeLessThanOrEqual(10);

    // No duplicate fill IDs across all orders
    const fillIds = bookFills.map((f) => f.id);
    expect(new Set(fillIds).size).toBe(fillIds.length);

    // Each resting sell order was filled at most once
    const pool = getPool();
    const makerOrders = await pool.query<{ id: string; qty_filled: string; status: string }>(
      `SELECT id, qty_filled::text, status
       FROM orders
       WHERE user_id = $1 AND side = 'SELL' AND type = 'LIMIT'
         AND pair_id = $2
       ORDER BY created_at`,
      [maker.userId, pair.pairId],
    );
    for (const o of makerOrders.rows) {
      // Each was 1 BTC — filled is 0 or 1, never > 1
      expect(parseFloat(o.qty_filled)).toBeLessThanOrEqual(1);
    }

    // Verify invariants
    const allUserIds = [maker.userId, ...takers.map((t) => t.userId)];
    await verifyInvariants(allUserIds);

    // Conservation: total base = 100 (maker initial)
    const baseSum = await pool.query<{ total: string }>(
      `SELECT SUM(balance)::text AS total FROM wallets
       WHERE asset_id = $1 AND user_id = ANY($2)`,
      [pair.baseId, allUserIds],
    );
    expect(parseFloat(baseSum.rows[0].total)).toBeCloseTo(100, 4);
  });
});

// ─────────────────────────────────────────────────────────
// Test suite 3: Concurrent cancels while matching
// ─────────────────────────────────────────────────────────

describe("Concurrency — cancel while matching", () => {
  it("cancel either succeeds or is rejected, no corruption", { timeout: 15000 }, async () => {
    const pair = await createPair();

    const seller = await createFundedUser("cc-cseller", pair, "10", "10000000");
    const buyer = await createFundedUser("cc-cbuyer", pair, "0", "10000000");

    // Seller places 5 LIMIT SELL (1 BTC each @ 50000)
    const sellOrderIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST", url: "/orders",
        headers: { authorization: `Bearer ${seller.token}` },
        payload: { pairId: pair.pairId, side: "SELL", type: "LIMIT", qty: "1", limitPrice: "50000" },
      });
      expect(res.statusCode).toBe(201);
      sellOrderIds.push(res.json().order.id);
    }

    // Concurrently: buyer buys 3 BTC + seller cancels all 5 sells
    const [buyResult, ...cancelResults] = await Promise.all([
      app.inject({
        method: "POST", url: "/orders",
        headers: { authorization: `Bearer ${buyer.token}` },
        payload: { pairId: pair.pairId, side: "BUY", type: "LIMIT", qty: "3", limitPrice: "50000" },
      }),
      ...sellOrderIds.map((id) =>
        app.inject({
          method: "DELETE", url: `/orders/${id}`,
          headers: { authorization: `Bearer ${seller.token}` },
        }),
      ),
    ]);

    // Buy should succeed
    expect(buyResult.statusCode).toBe(201);

    // Cancels: 200 (success) or 400 (order already filled/canceled)
    for (const res of cancelResults) {
      expect([200, 400]).toContain(res.statusCode);
    }

    // Every sell order has a valid terminal or open state
    const pool = getPool();
    const orders = await pool.query<{ id: string; status: string; qty_filled: string }>(
      `SELECT id, status, qty_filled::text FROM orders WHERE id = ANY($1)`,
      [sellOrderIds],
    );
    for (const o of orders.rows) {
      expect(["FILLED", "CANCELED", "PARTIALLY_FILLED", "OPEN"]).toContain(o.status);
      if (o.status === "FILLED") expect(parseFloat(o.qty_filled)).toBe(1);
      if (o.status === "CANCELED") expect(parseFloat(o.qty_filled)).toBeLessThanOrEqual(1);
    }

    // Buy fills 0–3 depending on race outcome with cancels
    const buyOrder = buyResult.json().order;
    const buyFilled = parseFloat(buyOrder.qty_filled);
    expect(buyFilled).toBeGreaterThanOrEqual(0);
    expect(buyFilled).toBeLessThanOrEqual(3);
    // Each filled BTC must be an integer (matched 1-BTC sell orders)
    expect(buyFilled % 1).toBeCloseTo(0, 8);

    // Verify invariants
    await verifyInvariants([seller.userId, buyer.userId]);

    // Conservation: total base = 10 (seller initial)
    const baseSum = await pool.query<{ total: string }>(
      `SELECT SUM(balance)::text AS total FROM wallets
       WHERE asset_id = $1 AND user_id = ANY($2)`,
      [pair.baseId, [seller.userId, buyer.userId]],
    );
    expect(parseFloat(baseSum.rows[0].total)).toBeCloseTo(10, 4);
  });
});
