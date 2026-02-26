import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, registerAndLogin, getPool } from "./helpers";

let app: FastifyInstance;

let adminToken: string;
let traderToken: string;
let traderId: string;
let pairId: string;
let baseAssetId: string;
let quoteAssetId: string;

const uid = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
  app = await getTestApp();
  const pool = getPool();

  // 1. Admin user
  const admin = await registerAndLogin(app, "idem-admin");
  await pool.query(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [admin.userId]);
  const adminLoginRes = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: admin.email, password: admin.password },
  });
  adminToken = adminLoginRes.json().accessToken;

  // 2. Trader user
  const trader = await registerAndLogin(app, "idem-trader");
  traderToken = trader.accessToken;
  traderId = trader.userId;

  // 3. Assets
  const btcRes = await app.inject({
    method: "POST",
    url: "/admin/assets",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { symbol: `I${uid}`, name: "BTC-Idem", decimals: 8 },
  });
  baseAssetId = btcRes.json().asset.id;

  const usdRes = await app.inject({
    method: "POST",
    url: "/admin/assets",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { symbol: `J${uid}`, name: "USD-Idem", decimals: 2 },
  });
  quoteAssetId = usdRes.json().asset.id;

  // 4. Pair (0 fee for simplicity)
  const pairRes = await app.inject({
    method: "POST",
    url: "/admin/pairs",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { baseAssetId, quoteAssetId, symbol: `K${uid}`, feeBps: 0 },
  });
  pairId = pairRes.json().pair.id;

  // 5. Set last price
  await app.inject({
    method: "PATCH",
    url: `/admin/pairs/${pairId}/price`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { price: "50000" },
  });

  // 6. Create + fund trader wallets
  const bw = await app.inject({
    method: "POST",
    url: "/wallets",
    headers: { authorization: `Bearer ${traderToken}` },
    payload: { assetId: baseAssetId },
  });
  const qw = await app.inject({
    method: "POST",
    url: "/wallets",
    headers: { authorization: `Bearer ${traderToken}` },
    payload: { assetId: quoteAssetId },
  });

  await app.inject({
    method: "POST",
    url: `/admin/wallets/${bw.json().wallet.id}/credit`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { amount: "10" },
  });
  await app.inject({
    method: "POST",
    url: `/admin/wallets/${qw.json().wallet.id}/credit`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { amount: "1000000" },
  });
});

afterAll(async () => {
  await closeTestApp();
});

describe("Idempotency — snapshot persistence", () => {
  it("returns identical order + fills on retry with same Idempotency-Key (MARKET)", async () => {
    const key = `test-idem-market-${Date.now()}`;

    // First request
    const res1 = await app.inject({
      method: "POST",
      url: "/orders",
      headers: {
        authorization: `Bearer ${traderToken}`,
        "idempotency-key": key,
      },
      payload: { pairId, side: "BUY", type: "MARKET", qty: "0.01" },
    });
    expect(res1.statusCode).toBe(201);
    const body1 = res1.json();
    expect(body1.ok).toBe(true);
    expect(body1.order.status).toBe("FILLED");

    // Retry with same key
    const res2 = await app.inject({
      method: "POST",
      url: "/orders",
      headers: {
        authorization: `Bearer ${traderToken}`,
        "idempotency-key": key,
      },
      payload: { pairId, side: "BUY", type: "MARKET", qty: "0.01" },
    });
    expect(res2.statusCode).toBe(201);
    const body2 = res2.json();

    // Order and fills must be identical
    expect(body2.order.id).toBe(body1.order.id);
    expect(body2.order.status).toBe(body1.order.status);
    expect(body2.order.qty_filled).toBe(body1.order.qty_filled);
    expect(body2.fills.length).toBe(body1.fills.length);
    if (body1.fills.length > 0) {
      expect(body2.fills[0].id).toBe(body1.fills[0].id);
    }
  });

  it("returns identical order on retry with same Idempotency-Key (LIMIT, no fills)", async () => {
    const key = `test-idem-limit-${Date.now()}`;

    // Place LIMIT SELL that rests on book (no match)
    const res1 = await app.inject({
      method: "POST",
      url: "/orders",
      headers: {
        authorization: `Bearer ${traderToken}`,
        "idempotency-key": key,
      },
      payload: { pairId, side: "SELL", type: "LIMIT", qty: "0.01", limitPrice: "99999" },
    });
    expect(res1.statusCode).toBe(201);
    const body1 = res1.json();
    expect(body1.order.status).toBe("OPEN");
    expect(body1.fills.length).toBe(0);

    // Retry with same key
    const res2 = await app.inject({
      method: "POST",
      url: "/orders",
      headers: {
        authorization: `Bearer ${traderToken}`,
        "idempotency-key": key,
      },
      payload: { pairId, side: "SELL", type: "LIMIT", qty: "0.01", limitPrice: "99999" },
    });
    expect(res2.statusCode).toBe(201);
    const body2 = res2.json();

    // Same order, no duplicate
    expect(body2.order.id).toBe(body1.order.id);
    expect(body2.fills.length).toBe(0);

    // Cleanup
    await app.inject({
      method: "DELETE",
      url: `/orders/${body1.order.id}`,
      headers: { authorization: `Bearer ${traderToken}` },
    });
  });

  it("different Idempotency-Keys create separate orders", async () => {
    const key1 = `test-idem-diff-a-${Date.now()}`;
    const key2 = `test-idem-diff-b-${Date.now()}`;

    const res1 = await app.inject({
      method: "POST",
      url: "/orders",
      headers: {
        authorization: `Bearer ${traderToken}`,
        "idempotency-key": key1,
      },
      payload: { pairId, side: "BUY", type: "MARKET", qty: "0.01" },
    });
    expect(res1.statusCode).toBe(201);

    const res2 = await app.inject({
      method: "POST",
      url: "/orders",
      headers: {
        authorization: `Bearer ${traderToken}`,
        "idempotency-key": key2,
      },
      payload: { pairId, side: "BUY", type: "MARKET", qty: "0.01" },
    });
    expect(res2.statusCode).toBe(201);

    // Different orders
    expect(res2.json().order.id).not.toBe(res1.json().order.id);
  });

  it("snapshot_json is stored in DB and is a valid Snapshot object", async () => {
    const key = `test-idem-snap-db-${Date.now()}`;
    const pool = getPool();

    // Place order with idempotency key
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: {
        authorization: `Bearer ${traderToken}`,
        "idempotency-key": key,
      },
      payload: { pairId, side: "BUY", type: "MARKET", qty: "0.01" },
    });
    expect(res.statusCode).toBe(201);

    // Check DB directly
    const dbResult = await pool.query(
      `SELECT snapshot_json FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
      [traderId, key]
    );
    expect(dbResult.rows.length).toBe(1);

    const snap = dbResult.rows[0].snapshot_json;
    // snapshot_json must not be the empty default
    expect(snap).not.toEqual({});
    // Must have Snapshot shape fields
    expect(snap).toHaveProperty("last");
    expect(snap).toHaveProperty("ts");
    expect(snap).toHaveProperty("source");
  });

  it("no Idempotency-Key header creates order normally without DB row", async () => {
    const pool = getPool();

    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${traderToken}` },
      payload: { pairId, side: "BUY", type: "MARKET", qty: "0.01" },
    });
    expect(res.statusCode).toBe(201);
    const orderId = res.json().order.id;

    // No idempotency row for this order
    const dbResult = await pool.query(
      `SELECT 1 FROM idempotency_keys WHERE order_id = $1`,
      [orderId]
    );
    expect(dbResult.rows.length).toBe(0);
  });
});
