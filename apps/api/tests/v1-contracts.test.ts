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
let traderBaseWalletId: string;
let traderQuoteWalletId: string;

const uid = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
    app = await getTestApp();
    const pool = getPool();

    // 1. Admin user
    const admin = await registerAndLogin(app, "v1-admin");
    await pool.query(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [admin.userId]);
    const adminLoginRes = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: admin.email, password: admin.password },
    });
    adminToken = adminLoginRes.json().accessToken;

    // 2. Trader user
    const trader = await registerAndLogin(app, "v1-trader");
    traderToken = trader.accessToken;
    traderId = trader.userId;

    // 3. Assets
    const btcRes = await app.inject({
        method: "POST",
        url: "/admin/assets",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { symbol: `V${uid}`, name: "V1 BTC", decimals: 8 },
    });
    baseAssetId = btcRes.json().asset.id;

    const usdRes = await app.inject({
        method: "POST",
        url: "/admin/assets",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { symbol: `W${uid}`, name: "V1 USD", decimals: 2 },
    });
    quoteAssetId = usdRes.json().asset.id;

    // 4. Pair
    const pairRes = await app.inject({
        method: "POST",
        url: "/admin/pairs",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { baseAssetId, quoteAssetId, symbol: `X${uid}`, feeBps: 0 },
    });
    pairId = pairRes.json().pair.id;

    await app.inject({
        method: "PATCH",
        url: `/admin/pairs/${pairId}/price`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { price: "50000" },
    });

    // 5. Wallets
    const bwRes = await app.inject({
        method: "POST",
        url: "/wallets",
        headers: { authorization: `Bearer ${traderToken}` },
        payload: { assetId: baseAssetId },
    });
    traderBaseWalletId = bwRes.json().wallet.id;

    const qwRes = await app.inject({
        method: "POST",
        url: "/wallets",
        headers: { authorization: `Bearer ${traderToken}` },
        payload: { assetId: quoteAssetId },
    });
    traderQuoteWalletId = qwRes.json().wallet.id;

    // 6. Credit wallets
    await app.inject({
        method: "POST",
        url: `/admin/wallets/${traderBaseWalletId}/credit`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { amount: "10" },
    });
    await app.inject({
        method: "POST",
        url: `/admin/wallets/${traderQuoteWalletId}/credit`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { amount: "1000000" },
    });

    // 7. Place 3 LIMIT orders for pagination tests
    for (let i = 0; i < 3; i++) {
        await app.inject({
            method: "POST",
            url: "/orders",
            headers: { authorization: `Bearer ${traderToken}` },
            payload: {
                pairId,
                side: "BUY",
                type: "LIMIT",
                qty: "0.1",
                limitPrice: `${49000 + i}`,
            },
        });
    }
});

afterAll(async () => {
    await closeTestApp();
});

// ── /v1/orders ──────────────────────────────────────

describe("GET /v1/orders", () => {
    it("returns { data, nextCursor } envelope", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/v1/orders",
            headers: { authorization: `Bearer ${traderToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toHaveProperty("data");
        expect(body).toHaveProperty("nextCursor");
        expect(Array.isArray(body.data)).toBe(true);
    });

    it("paginates with limit=2 and nextCursor", async () => {
        // Page 1
        const res1 = await app.inject({
            method: "GET",
            url: "/v1/orders?limit=2",
            headers: { authorization: `Bearer ${traderToken}` },
        });
        const page1 = res1.json();
        expect(page1.data).toHaveLength(2);
        expect(page1.nextCursor).not.toBeNull();

        // Page 2
        const res2 = await app.inject({
            method: "GET",
            url: `/v1/orders?limit=2&cursor=${page1.nextCursor}`,
            headers: { authorization: `Bearer ${traderToken}` },
        });
        const page2 = res2.json();
        expect(page2.data).toHaveLength(1);
        expect(page2.nextCursor).toBeNull();

        // No overlap between pages
        const page1Ids = page1.data.map((o: any) => o.id);
        const page2Ids = page2.data.map((o: any) => o.id);
        for (const id of page2Ids) {
            expect(page1Ids).not.toContain(id);
        }
    });

    it("filters by status", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/v1/orders?status=OPEN",
            headers: { authorization: `Bearer ${traderToken}` },
        });
        const body = res.json();
        expect(res.statusCode).toBe(200);
        for (const order of body.data) {
            expect(order.status).toBe("OPEN");
        }
    });

    it("returns ordered by created_at DESC", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/v1/orders",
            headers: { authorization: `Bearer ${traderToken}` },
        });
        const body = res.json();
        const dates = body.data.map((o: any) => new Date(o.created_at).getTime());
        for (let i = 1; i < dates.length; i++) {
            expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
        }
    });
});

// ── /v1/wallets/:id/transactions ────────────────────

describe("GET /v1/wallets/:id/transactions", () => {
    it("returns paginated ledger entries", async () => {
        const res = await app.inject({
            method: "GET",
            url: `/v1/wallets/${traderQuoteWalletId}/transactions`,
            headers: { authorization: `Bearer ${traderToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toHaveProperty("data");
        expect(body).toHaveProperty("nextCursor");
        expect(Array.isArray(body.data)).toBe(true);
    });

    it("returns 403 for wallet owned by another user", async () => {
        // Create a second user
        const other = await registerAndLogin(app, "v1-other");
        const res = await app.inject({
            method: "GET",
            url: `/v1/wallets/${traderQuoteWalletId}/transactions`,
            headers: { authorization: `Bearer ${other.accessToken}` },
        });
        expect(res.statusCode).toBe(403);
        const body = res.json();
        expect(body.code).toBe("forbidden");
        expect(body).toHaveProperty("requestId");
    });

    it("returns 404 for nonexistent wallet", async () => {
        const res = await app.inject({
            method: "GET",
            url: `/v1/wallets/00000000-0000-0000-0000-000000000000/transactions`,
            headers: { authorization: `Bearer ${traderToken}` },
        });
        expect(res.statusCode).toBe(404);
        const body = res.json();
        expect(body.code).toBe("wallet_not_found");
        expect(body).toHaveProperty("requestId");
    });
});

// ── /v1/pairs ───────────────────────────────────────

describe("GET /v1/pairs", () => {
    it("returns { data, nextCursor: null }", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/v1/pairs",
            headers: { authorization: `Bearer ${traderToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toHaveProperty("data");
        expect(body.nextCursor).toBeNull();
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.length).toBeGreaterThan(0);
    });
});

// ── /v1/equity ──────────────────────────────────────

describe("GET /v1/equity", () => {
    it("returns { data, nextCursor } envelope", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/v1/equity",
            headers: { authorization: `Bearer ${traderToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toHaveProperty("data");
        expect(body).toHaveProperty("nextCursor");
        expect(Array.isArray(body.data)).toBe(true);
    });
});

// ── V1 error envelope ───────────────────────────────

describe("V1 error envelope", () => {
    it("includes code, message, requestId on error", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/v1/wallets/00000000-0000-0000-0000-000000000000/transactions",
            headers: { authorization: `Bearer ${traderToken}` },
        });
        expect(res.statusCode).toBe(404);
        const body = res.json();
        expect(body).toHaveProperty("code");
        expect(body).toHaveProperty("message");
        expect(body).toHaveProperty("requestId");
        expect(typeof body.requestId).toBe("string");
        expect(body.requestId.length).toBeGreaterThan(0);
    });

    it("returns 401 for unauthenticated request", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/v1/orders",
        });
        expect(res.statusCode).toBe(401);
    });
});
