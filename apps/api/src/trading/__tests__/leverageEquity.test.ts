/**
 * leverageEquity.test.ts: equity and GET /positions with ISOLATED positions
 * (docs/designs/2026-10-13-leverage-design.md §2.2, accountEquity).
 *
 * An ISOLATED position holds no base, so valuing it as base_qty × mark (the
 * SPOT formula) would count a 10x long as ten times its margin. It's worth
 * its margin + unrealized P&L instead, floored at 0 (the loss is capped at
 * the margin). SPOT rows are valued exactly as before.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import Decimal from "decimal.js";
import { D } from "../../utils/decimal";
import { buildApp } from "../../app";
import { pool } from "../../db/pool";
import { config } from "../../config";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { getPortfolioSummary } from "../../portfolio/portfolioService";
import { positionValue } from "../../analytics/accountEquity";
import { resetMarketDataPairIdCache } from "../../market/marketSymbols";

describe("positionValue (pure)", () => {
    const iso = (qty: string, entry: string, margin: string) =>
        ({ base_qty: qty, avg_entry_price: entry, margin_mode: "ISOLATED" as const, isolated_margin: margin });

    it("SPOT: base × mark, uPnL on the entry (unchanged)", () => {
        const v = positionValue({ base_qty: "-2", avg_entry_price: "100", margin_mode: "SPOT", isolated_margin: "0" }, D(90));
        expect(v.holdings.toNumber()).toBe(-180);
        expect(v.unrealized.toNumber()).toBe(20);
    });

    it("ISOLATED long: margin + uPnL", () => {
        const v = positionValue(iso("0.01", "83000", "83"), D(84000));
        expect(v.unrealized.toNumber()).toBe(10);
        expect(v.holdings.toNumber()).toBe(93);
    });

    it("ISOLATED short: margin + uPnL", () => {
        const v = positionValue(iso("-0.01", "83000", "83"), D(84000));
        expect(v.unrealized.toNumber()).toBe(-10);
        expect(v.holdings.toNumber()).toBe(73);
    });

    it("ISOLATED past bankruptcy: worth 0, loss capped at the margin", () => {
        const v = positionValue(iso("0.01", "83000", "83"), D(70000));
        expect(v.holdings.toNumber()).toBe(0);
        expect(v.unrealized.toNumber()).toBe(-83);
    });
});

describe("with the engine", () => {
    let app: FastifyInstance;
    let pairId: string;
    let userId: string;
    let usdAssetId: string;
    const saved = { ...config.leverage };

    const auth = (sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` });
    const post = (body: Record<string, unknown>) =>
        app.inject({ method: "POST", url: "/orders", headers: auth(userId), payload: { pairId, ...body } });

    beforeAll(async () => {
        await ensureMigrations();
        app = await buildApp({
            logger: false, disableKrakenFeed: true, disableTriggerEngine: true, disableJobRunner: true,
            disableOutboxWorker: true, disableLockSampler: true, disableOrchestrator: true,
        });
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(async () => {
        await resetTestData();
        clearReferenceBooks();
        const assets = await createTestAssetAndPair(pool);
        pairId = assets.pair.id;
        usdAssetId = assets.usdAsset.id;
        userId = (await createTestUser(pool)).id;
        await createTestWallets(pool, userId, assets.btcAsset.id, usdAssetId, "0.00000000", "1000.00000000");
        seedReferenceBook(pairId, "83000", "83000");
        resetMarketDataPairIdCache(); // the fixture pair's id is new each reset
    });

    afterEach(() => {
        Object.assign(config.leverage, saved, { allowlist: [...saved.allowlist] });
    });

    it("POST /orders: leverage above 1 with the flag off is a 400", async () => {
        const res = await post({ side: "BUY", type: "MARKET", qty: "0.00100000", leverage: 2 });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("leverage_exceeds_cap");
    });

    it("POST /orders → GET /positions: a 10x long carries leverage, margin, liq, mark and health", async () => {
        Object.assign(config.leverage, { enabled: true, maxFreePlay: 10, allowlist: [] });
        const res = await post({ side: "BUY", type: "MARKET", qty: "0.00602409", leverage: 10 });
        expect(res.statusCode, res.body).toBe(201);

        const list = await app.inject({ method: "GET", url: "/positions", headers: auth(userId) });
        const [p] = list.json().positions;
        expect(p.margin_mode).toBe("ISOLATED");
        expect(Number(p.leverage)).toBe(10);
        expect(p.isolated_margin).toBe("49.99994700");
        expect(Number(new Decimal(p.liq_price).toFixed(2))).toBeCloseTo(75075.38, 1);
        expect(p.mark_price).toBe("83000.00000000");
        expect(Number(p.margin_health)).toBe(1);
    });

    it("GET /positions: a SPOT row has exactly the keys it had before leverage", async () => {
        expect((await post({ side: "BUY", type: "MARKET", qty: "0.00100000" })).statusCode).toBe(201);
        const list = await app.inject({ method: "GET", url: "/positions", headers: auth(userId) });
        const [p] = list.json().positions;
        expect(Object.keys(p).sort()).toEqual([
            "avg_entry_price", "base_qty", "current_price", "fees_paid_quote", "pair_id",
            "realized_pnl_quote", "unrealized_pnl_quote", "updated_at", "user_id",
        ]);
    });

    it("portfolio equity counts an ISOLATED position at margin + uPnL, not base × mark", async () => {
        Object.assign(config.leverage, { enabled: true, maxFreePlay: 10, allowlist: [] });
        expect((await post({ side: "BUY", type: "MARKET", qty: "0.00602409", leverage: 10 })).statusCode).toBe(201);

        const s = await getPortfolioSummary(userId);
        // USD 949.75005327 + margin 49.999947 + uPnL 0 = 1000 − the open fee.
        expect(s.cash_quote).toBe("949.75005327");
        expect(s.holdings_quote).toBe("49.99994700");
        expect(s.equity_quote).toBe("999.75000027");

        // The per-fill snapshot agrees.
        const { rows: [snap] } = await pool.query<{ equity_quote: string; holdings_quote: string }>(
            `SELECT equity_quote::text, holdings_quote::text FROM equity_snapshots WHERE user_id = $1 ORDER BY ts DESC LIMIT 1`,
            [userId]);
        expect(snap.equity_quote).toBe("999.75000027");
        expect(snap.holdings_quote).toBe("49.99994700");
    });
});
