/**
 * markAndMarginWarning.test.ts: one mark everywhere + margin warnings
 * (leverage PR 7, docs/designs/2026-10-13-leverage-design.md §2.3, §4).
 *
 *   mark.price            the liquidation engine publishes the mark it
 *                         evaluates with (the Kraken book mid), at most every
 *                         MARK_PUBLISH_MS per pair, and at once when the pair
 *                         pauses or resumes ({ paused: true, mark: null }).
 *   GET /positions        an ISOLATED row's mark_price, unrealized P&L and
 *                         margin_health use that same mark; with the feed
 *                         stale it falls back to the ticker and says so
 *                         (mark_stale: true).
 *   margin_warning        a user-scoped position.margin_warning when an
 *                         ISOLATED position's health drops below 25%, once
 *                         per episode; it re-arms above 35%. Never on a
 *                         paused pair, for bots, or for SPOT rows.
 *
 * The worked example: $50 at 10x long BTC from 83,000 (MMR 0.5%) has its liq
 * price at 75,075.38; health is 1 at entry and 0 there.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { pool } from "../../db/pool";
import { config } from "../../config";
import { buildApp } from "../../app";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { resetMarketDataPairIdCache } from "../../market/marketSymbols";
import { subscribeGlobal, unsubscribe, type EventHandler } from "../../events/eventBus";
import type { AppEvent } from "../../events/eventTypes";
import { placeOrderWithSnapshot } from "../phase6OrderService";
import { LiquidationEngine, MARK_PUBLISH_MS, type FeedStatus } from "../liquidationEngine";
import { __setFeedStatusForTest } from "../liquidationMark";

let pairId: string;
let btcAssetId: string;
let usdAssetId: string;
const saved = { ...config.leverage };
const SIZE = "0.00602409"; // $50 margin at 10x from 83,000

let feed: FeedStatus = "ok";
const newEngine = () => new LiquidationEngine({ feedStatus: () => feed, useLeadership: false });

function flagOn(mode: "log_only" | "execute" = "log_only") {
    Object.assign(config.leverage, {
        enabled: true, liquidationMode: mode, maxFreePlay: 10, maxMatch: 5, maxCompetition: 1, allowlist: [],
    });
}

async function trader(usd = "1000.00000000", email?: string): Promise<string> {
    const u = await createTestUser(pool, email ? { email } : {});
    await createTestWallets(pool, u.id, btcAssetId, usdAssetId, "0.00000000", usd);
    return u.id;
}

const order = (uid: string, side: "BUY" | "SELL", qty: string, leverage?: number) =>
    placeOrderWithSnapshot(uid, { pairId, side, type: "MARKET", qty, leverage });

let events: AppEvent[] = [];
let handler: EventHandler;
const ofType = <T extends AppEvent["type"]>(type: T) =>
    events.filter((e): e is Extract<AppEvent, { type: T }> => e.type === type);

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    await resetTestData();
    clearReferenceBooks();
    const assets = await createTestAssetAndPair(pool);
    pairId = assets.pair.id;
    btcAssetId = assets.btcAsset.id;
    usdAssetId = assets.usdAsset.id;
    seedReferenceBook(pairId, "83000", "83000");
    resetMarketDataPairIdCache();
    feed = "ok";
    events = [];
    handler = (e) => events.push(e);
    subscribeGlobal(handler);
});

afterEach(() => {
    unsubscribe(handler);
    Object.assign(config.leverage, saved, { allowlist: [...saved.allowlist] });
});

describe("mark.price: the engine publishes the mark it evaluates with", () => {
    beforeEach(() => flagOn());

    it("the Kraken book mid, throttled per pair", async () => {
        const engine = newEngine();
        seedReferenceBook(pairId, "79910", "79928");
        const t0 = Date.now();
        await engine.evaluatePair(pairId, t0);
        await engine.evaluatePair(pairId, t0 + 100);              // inside the throttle window
        await engine.evaluatePair(pairId, t0 + MARK_PUBLISH_MS);   // due again
        const marks = ofType("mark.price");
        expect(marks).toHaveLength(2);
        expect(marks[0].data).toMatchObject({ pairId, mark: "79919.00000000", paused: false, feed: "ok" });
        expect(marks[0].userId).toBeUndefined(); // global (pair-scoped on the SSE stream)
    });

    it("paused (feed not ok, or the book too old) is published at once, with no mark; resume likewise", async () => {
        const engine = newEngine();
        const t0 = Date.now();
        await engine.evaluatePair(pairId, t0);
        feed = "stale";
        await engine.evaluatePair(pairId, t0 + 10);
        feed = "ok";
        await engine.evaluatePair(pairId, t0 + 20);
        seedReferenceBook(pairId, "83000", "83000", 60_000); // ok feed, but an old book
        await engine.evaluatePair(pairId, t0 + 30);
        const marks = ofType("mark.price").map((e) => e.data);
        expect(marks.map((m) => [m.paused, m.mark, m.feed])).toEqual([
            [false, "83000.00000000", "ok"],
            [true, null, "stale"],
            [false, "83000.00000000", "ok"],
            [true, null, "ok"],
        ]);
    });

    it("LIQUIDATION_MODE=off: the engine doesn't run, so no mark is published", async () => {
        flagOn();
        config.leverage.liquidationMode = "off";
        await newEngine().evaluatePair(pairId);
        expect(ofType("mark.price")).toEqual([]);
    });
});

describe("position.margin_warning", () => {
    let u: string;
    beforeEach(async () => {
        flagOn();
        u = await trader();
        await order(u, "BUY", SIZE, 10); // liq 75,075.38; health 25% ≈ 77,056
    });

    async function at(engine: LiquidationEngine, price: string, t: number) {
        seedReferenceBook(pairId, price, price);
        await engine.evaluatePair(pairId, t);
    }

    it("below 25%: one warning, to the owner, with the numbers; not again until it recovers above 35%", async () => {
        const engine = newEngine();
        const t0 = Date.now();
        await at(engine, "80000", t0);           // ~62%: nothing
        await at(engine, "77000", t0 + 1_000);   // ~24%: warn
        await at(engine, "76500", t0 + 2_000);   // still under: no repeat
        await at(engine, "78000", t0 + 3_000);   // ~37%: re-armed
        await at(engine, "76900", t0 + 4_000);   // under again: warn again
        const warnings = ofType("position.margin_warning");
        expect(warnings).toHaveLength(2);
        const w = warnings[0];
        expect(w.userId).toBe(u);
        expect(w.data).toMatchObject({
            pairId, competitionId: null, matchId: null, side: "LONG", leverage: "10.00",
            mark: "77000.00000000", threshold: 0.25,
        });
        expect(Number(w.data.marginHealth)).toBeGreaterThan(0.2);
        expect(Number(w.data.marginHealth)).toBeLessThan(0.25);
        expect(Number(w.data.liqPrice)).toBeCloseTo(75075.38, 1);
    });

    it("between 25% and 35% after a warning: still no repeat (hysteresis)", async () => {
        const engine = newEngine();
        const t0 = Date.now();
        await at(engine, "77000", t0);
        await at(engine, "77600", t0 + 1_000); // ~31%
        await at(engine, "77000", t0 + 2_000);
        expect(ofType("position.margin_warning")).toHaveLength(1);
    });

    it("a new position (next epoch) warns again", async () => {
        const engine = newEngine();
        const t0 = Date.now();
        await at(engine, "77000", t0);
        seedReferenceBook(pairId, "77000", "77000");
        await order(u, "SELL", SIZE);           // close
        seedReferenceBook(pairId, "83000", "83000");
        await order(u, "BUY", SIZE, 10);        // reopen at 83,000
        await at(engine, "77000", t0 + 1_000);
        expect(ofType("position.margin_warning")).toHaveLength(2);
    });

    it("no warning on a paused pair (no trustworthy mark)", async () => {
        const engine = newEngine();
        feed = "stale";
        await at(engine, "77000", Date.now());
        expect(ofType("position.margin_warning")).toEqual([]);
    });

    it("bots and SPOT positions never get one", async () => {
        Object.assign(config.leverage, { enabled: false });
        const spot = await trader("100000.00000000");
        await order(spot, "BUY", "0.10000000");
        flagOn();
        const bot = await trader("100000.00000000", "mmbot-lev7@system.local");
        await order(bot, "BUY", "0.10000000");
        const engine = newEngine();
        await at(engine, "70000", Date.now());
        expect(ofType("position.margin_warning").map((e) => e.userId)).toEqual([u]);
    });
});

describe("GET /positions: an ISOLATED row uses the engine's mark", () => {
    let app: FastifyInstance;
    const auth = (sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` });

    beforeAll(async () => {
        app = await buildApp({
            logger: false, disableKrakenFeed: true, disableTriggerEngine: true, disableJobRunner: true,
            disableOutboxWorker: true, disableLockSampler: true, disableOrchestrator: true,
        });
        await app.ready();
    });
    afterAll(async () => {
        await app.close();
    });
    afterEach(() => __setFeedStatusForTest(null));

    async function isolatedRow(u: string) {
        const res = await app.inject({ method: "GET", url: "/positions", headers: auth(u) });
        return res.json().positions[0];
    }

    it("feed ok: mark_price is the book mid (not the last trade), and P&L / health follow it", async () => {
        flagOn();
        const u = await trader();
        await order(u, "BUY", SIZE, 10);
        __setFeedStatusForTest(() => "ok");
        seedReferenceBook(pairId, "79910", "79928");
        const p = await isolatedRow(u);
        expect(p.current_price).toBe("83000.00000000"); // the ticker / last trade, unchanged
        expect(p.mark_price).toBe("79919.00000000");
        expect(p.mark_stale).toBe(false);
        expect(Number(p.unrealized_pnl_quote)).toBeCloseTo(0.00602409 * (79919 - 83000), 6);
        expect(Number(p.margin_health)).toBeCloseTo(0.6112, 3);
    });

    it("feed stale: falls back to the ticker and says so", async () => {
        flagOn();
        const u = await trader();
        await order(u, "BUY", SIZE, 10);
        __setFeedStatusForTest(() => "stale");
        const p = await isolatedRow(u);
        expect(p.mark_price).toBe("83000.00000000");
        expect(p.mark_stale).toBe(true);
    });
});
