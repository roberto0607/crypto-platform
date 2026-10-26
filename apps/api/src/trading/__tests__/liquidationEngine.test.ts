/**
 * liquidationEngine.test.ts: the liquidation engine (leverage PR 4,
 * docs/designs/2026-10-13-leverage-design.md §2.3, §3, §7).
 *
 *   modes      off: nothing runs. log_only: one LOG_ONLY row per position
 *              episode, positions and wallets untouched. execute: closes at
 *              the touch through the order pipeline, loss-capped, leftover
 *              margin returned, EXECUTED row, event, notification, triggers
 *              canceled.
 *   numbers    the design's worked example: $50 at 10x long BTC from 83,000
 *              liquidates at/below 75,075.37688 (75,075.38 to the cent);
 *              the short at/above 90,845.77114 (90,845.77); a gap past
 *              bankruptcy is absorbed and USD never goes negative.
 *   stale      no fresh Kraken book (or krakenWs not ok) pauses the pair:
 *              never liquidated on a stale book or the ticker; SKIPPED_STALE
 *              recorded once; resumes when the book is back.
 *   glitch     two breaching evaluations ≥ 500 ms apart before anything.
 *   bots       @system.local users are never liquidated.
 *   guard      the matching engine re-checks every liquidation under its
 *              locks: stale book, no breach, another epoch → no-op.
 *
 * Real Postgres; the engine is driven with an explicit clock.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import Decimal from "decimal.js";
import { pool } from "../../db/pool";
import { config } from "../../config";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks, seedTicker } from "../../testing/referenceBook";
import { placeOrderWithSnapshot } from "../phase6OrderService";
import { createTriggerOrder } from "../../triggers/triggerRepo";
import { subscribeGlobal, unsubscribe, type EventHandler } from "../../events/eventBus";
import { LiquidationEngine, type FeedStatus, type PairEvaluation } from "../liquidationEngine";
import type { LiquidationMode } from "../leverageConfig";

let pairId: string;
let btcAssetId: string;
let usdAssetId: string;
let userId: string;

const savedLeverage = { ...config.leverage };

function setup(mode: LiquidationMode) {
    Object.assign(config.leverage, {
        enabled: true, liquidationMode: mode, maxFreePlay: 10, maxMatch: 5, maxCompetition: 1, allowlist: [],
    });
}

let feed: FeedStatus = "ok";
const newEngine = () => new LiquidationEngine({ feedStatus: () => feed, useLeadership: false });

const order = (uid: string, side: "BUY" | "SELL", qty: string, leverage?: number) =>
    placeOrderWithSnapshot(uid, { pairId, side, type: "MARKET", qty, leverage });

/** Call the matching engine's liquidation path directly (what the engine does once confirmed). */
const liquidate = (uid: string, epoch: number, side: "LONG" | "SHORT", qty = SIZE) =>
    placeOrderWithSnapshot(
        uid, { pairId, side: side === "LONG" ? "SELL" : "BUY", type: "MARKET", qty },
        undefined, undefined, null, null, "liquidation", { epoch, side },
    );

async function newTrader(usd = "1000.00000000", email?: string): Promise<string> {
    const u = await createTestUser(pool, email ? { email } : {});
    await createTestWallets(pool, u.id, btcAssetId, usdAssetId, "0.00000000", usd);
    return u.id;
}

async function usd(uid: string): Promise<string> {
    const { rows } = await pool.query<{ balance: string }>(
        `SELECT balance::text FROM wallets WHERE user_id = $1 AND asset_id = $2 AND competition_id IS NULL AND match_id IS NULL`,
        [uid, usdAssetId],
    );
    return rows[0].balance;
}

type Pos = { base_qty: string; isolated_margin: string; liq_price: string | null; epoch: number; margin_mode: string };
async function position(uid: string): Promise<Pos> {
    const { rows } = await pool.query<Pos>(
        `SELECT base_qty::text, isolated_margin::text, liq_price::text, epoch, margin_mode FROM positions
         WHERE user_id = $1 AND pair_id = $2 AND competition_id IS NULL AND match_id IS NULL`,
        [uid, pairId],
    );
    return rows[0];
}

type LiqRow = {
    mode: string; side: string; position_epoch: number; qty: string; entry_price: string; leverage: string;
    margin: string; liq_price: string; mark_price: string; fill_price: string | null; realized_pnl: string | null;
    fee: string | null; returned_equity: string | null; shortfall: string; order_id: string | null; book_age_ms: number | null;
};
async function liquidations(uid: string, mode?: string): Promise<LiqRow[]> {
    const { rows } = await pool.query<LiqRow>(
        `SELECT mode, side, position_epoch, qty::text, entry_price::text, leverage::text, margin::text,
                liq_price::text, mark_price::text, fill_price::text, realized_pnl::text, fee::text,
                returned_equity::text, shortfall::text, order_id, book_age_ms
         FROM liquidations WHERE user_id = $1 AND ($2::text IS NULL OR mode = $2) ORDER BY created_at`,
        [uid, mode ?? null],
    );
    return rows;
}

/** Everything a log-only evaluation must not touch, for a before/after compare. */
async function accountState(uid: string) {
    const q = async (sql: string) => (await pool.query(sql, [uid])).rows;
    return {
        wallets: await q(`SELECT asset_id, balance::text, reserved::text FROM wallets WHERE user_id = $1 ORDER BY asset_id`),
        ledger: await q(`SELECT l.entry_type, l.amount::text FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id
                         WHERE w.user_id = $1 ORDER BY l.created_at, l.ctid`),
        positions: await q(`SELECT base_qty::text, avg_entry_price::text, isolated_margin::text, liq_price::text, epoch,
                                   realized_pnl_quote::text, fees_paid_quote::text FROM positions WHERE user_id = $1`),
        orders: await q(`SELECT id, status FROM orders WHERE user_id = $1 ORDER BY created_at`),
    };
}

const cents = (v: string | null | undefined) =>
    v == null ? null : Number(new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2));

/** Two evaluations CONFIRM_MS+ apart: the glitch guard's confirmation. */
async function evaluateTwice(engine: LiquidationEngine, t0 = Date.now()): Promise<[PairEvaluation, PairEvaluation]> {
    const first = await engine.evaluatePair(pairId, t0);
    const second = await engine.evaluatePair(pairId, t0 + 600);
    return [first, second];
}

// $50 at 10x at 83,000: size 0.00602409 (rounded down), notional 499.99947.
const SIZE = "0.00602409";
const MARGIN = "49.99994700";
const OPEN_FEE = new Decimal("0.24999973");

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    await resetTestData();
    clearReferenceBooks();
    feed = "ok";
    const assets = await createTestAssetAndPair(pool);
    pairId = assets.pair.id;
    btcAssetId = assets.btcAsset.id;
    usdAssetId = assets.usdAsset.id;
    userId = await newTrader();
    seedReferenceBook(pairId, "83000", "83000");
});

afterEach(() => {
    Object.assign(config.leverage, savedLeverage, { allowlist: [...savedLeverage.allowlist] });
});

describe("execute: the design's numbers", () => {
    beforeEach(() => setup("execute"));

    it("10x long from 83,000: liq 75,075.37688442 (75,075.38); not at 75,075.38, liquidated at 75,075.37", async () => {
        await order(userId, "BUY", SIZE, 10);
        const p = await position(userId);
        expect(p.liq_price).toBe("75075.37688442");
        expect(cents(p.liq_price)).toBe(75075.38);

        const engine = newEngine();
        seedReferenceBook(pairId, "75075.38", "75075.38");
        const [a, b] = await evaluateTwice(engine);
        expect(a).toMatchObject({ status: "evaluated", candidates: 0 });
        expect(b).toMatchObject({ status: "evaluated", candidates: 0 });
        expect((await position(userId)).base_qty).toBe(SIZE);

        seedReferenceBook(pairId, "75075.37", "75075.37");
        const [c, d] = await evaluateTwice(engine, Date.now() + 2_000);
        expect(c).toMatchObject({ candidates: 1, pending: 1, executed: 0 });
        expect(d).toMatchObject({ candidates: 1, executed: 1 });
        expect((await position(userId)).base_qty).toBe("0.00000000");
    });

    it("10x short from 83,000: liq 90,845.77114427 (90,845.77); not at 90,845.77, liquidated at 90,845.78", async () => {
        await order(userId, "SELL", SIZE, 10);
        const p = await position(userId);
        expect(p.liq_price).toBe("90845.77114427");
        expect(cents(p.liq_price)).toBe(90845.77);

        const engine = newEngine();
        seedReferenceBook(pairId, "90845.77", "90845.77");
        expect((await evaluateTwice(engine))[1]).toMatchObject({ candidates: 0 });

        seedReferenceBook(pairId, "90845.78", "90845.78");
        const [, d] = await evaluateTwice(engine, Date.now() + 2_000);
        expect(d).toMatchObject({ executed: 1 });
        const [row] = await liquidations(userId, "EXECUTED");
        expect(row).toMatchObject({ side: "SHORT", fill_price: "90845.78000000" }); // a short closes at the ask
        expect((await position(userId)).base_qty).toBe("0.00000000");
    });

    it("liquidated at bid 75,060: pnl −47.83, fee 0.23, $1.94 returned; total loss $48.31; row, event, notification", async () => {
        const events: { type: string; data: Record<string, unknown>; userId?: string }[] = [];
        const capture: EventHandler = (e) => {
            if (e.type === "position.liquidated") events.push({ type: e.type, data: e.data as unknown as Record<string, unknown>, userId: e.userId });
        };
        subscribeGlobal(capture);
        try {
            await order(userId, "BUY", SIZE, 10);
            seedReferenceBook(pairId, "75060", "75061");
            const [, b] = await evaluateTwice(newEngine());
            expect(b).toMatchObject({ executed: 1 });
        } finally {
            unsubscribe(capture);
        }

        const [row] = await liquidations(userId);
        expect(row).toMatchObject({
            mode: "EXECUTED", side: "LONG", position_epoch: 1, qty: SIZE, entry_price: "83000.00000000",
            leverage: "10.00", margin: MARGIN, liq_price: "75075.37688442",
            mark_price: "75060.50000000", fill_price: "75060.00000000", shortfall: "0.00000000",
        });
        expect(cents(row.realized_pnl)).toBe(-47.83);
        expect(cents(row.fee)).toBe(0.23);
        expect(cents(row.returned_equity)).toBe(1.94);
        expect(row.order_id).not.toBeNull();

        // USD: 1000 − 50.25 (margin + open fee) + 1.94 returned.
        expect(cents(await usd(userId))).toBe(951.69);
        expect(cents(new Decimal(1000).minus(await usd(userId)).toFixed(8))).toBe(48.31);
        const p = await position(userId);
        expect(p).toMatchObject({ base_qty: "0.00000000", isolated_margin: "0.00000000", liq_price: null, epoch: 1 });

        const { rows: [o] } = await pool.query<{ source: string; side: string; type: string; status: string; qty: string }>(
            `SELECT source, side, type, status, qty::text FROM orders WHERE id = $1`, [row.order_id]);
        expect(o).toEqual({ source: "liquidation", side: "SELL", type: "MARKET", status: "FILLED", qty: SIZE });

        expect(events).toHaveLength(1);
        expect(events[0].userId).toBe(userId);
        expect(events[0].data).toMatchObject({ side: "LONG", fillPrice: "75060.00000000", markPrice: "75060.50000000" });

        const { rows: notes } = await pool.query<{ kind: string; title: string; body: string }>(
            `SELECT kind, title, body FROM notifications WHERE user_id = $1`, [userId]);
        expect(notes).toEqual([{ kind: "POSITION_LIQUIDATED", title: "BTC/USD 10x LONG liquidated", body: "Liquidated at $75,060.00. $1.94 margin returned." }]);
    });

    it("a gap past bankruptcy (74,000): margin lost and no more, shortfall $4.22 absorbed, fee uncollected", async () => {
        await order(userId, "BUY", SIZE, 10);
        seedReferenceBook(pairId, "74000", "74000");
        expect((await evaluateTwice(newEngine()))[1]).toMatchObject({ executed: 1 });

        const [row] = await liquidations(userId);
        expect(row.realized_pnl).toBe("-" + MARGIN);
        expect(row.returned_equity).toBe("0.00000000");
        expect(row.fee).toBe("0.00000000");
        expect(cents(row.shortfall)).toBe(4.22);
        // USD is down exactly the margin + open fee: the $50.25 and nothing more.
        expect(await usd(userId)).toBe(new Decimal(1000).minus(MARGIN).minus(OPEN_FEE).toFixed(8));
    });

    it("a fully invested user gapped through bankruptcy ends at $0, never negative", async () => {
        const all = new Decimal(MARGIN).plus(OPEN_FEE).toFixed(8);
        const broke = await newTrader(all);
        await order(broke, "BUY", SIZE, 10);
        expect(await usd(broke)).toBe("0.00000000");

        seedReferenceBook(pairId, "60000", "60000");
        expect((await evaluateTwice(newEngine()))[1]).toMatchObject({ executed: 1 });
        expect(await usd(broke)).toBe("0.00000000");
        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*) AS n FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id
             WHERE w.user_id = $1 AND l.balance_after < 0`, [broke]);
        expect(rows[0].n).toBe("0");
    });

    it("cancels the position's protective triggers (#202) in the same transaction", async () => {
        await order(userId, "BUY", SIZE, 10);
        const tp = await createTriggerOrder({ userId, pairId, kind: "TAKE_PROFIT_MARKET", side: "SELL", triggerPrice: "90000", qty: SIZE, matchId: null });
        seedReferenceBook(pairId, "75000", "75000");
        await evaluateTwice(newEngine());
        const { rows } = await pool.query<{ status: string; fail_reason: string | null }>(
            `SELECT status, fail_reason FROM trigger_orders WHERE id = $1`, [tp.id]);
        expect(rows[0].status).toBe("CANCELED");
    });
});

describe("log_only", () => {
    beforeEach(() => setup("log_only"));

    it("writes one LOG_ONLY row per episode and never touches the position, wallets, ledger or orders", async () => {
        await order(userId, "BUY", SIZE, 10);
        const before = await accountState(userId);

        seedReferenceBook(pairId, "75000", "75000");
        const engine = newEngine();
        const t0 = Date.now();
        const results = [];
        for (let i = 0; i < 6; i++) results.push(await engine.evaluatePair(pairId, t0 + i * 600));
        // A second engine (another instance) can't add a row either.
        results.push(...(await evaluateTwice(newEngine(), t0 + 3_600)));

        expect(results[0]).toMatchObject({ pending: 1, logged: 0 });
        expect(results[1]).toMatchObject({ logged: 1 });
        expect(results.slice(2).every((r) => r.status === "evaluated" && r.logged === 0 && r.executed === 0)).toBe(true);

        const rows = await liquidations(userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            mode: "LOG_ONLY", side: "LONG", position_epoch: 1, qty: SIZE, margin: MARGIN,
            liq_price: "75075.37688442", mark_price: "75000.00000000", fill_price: null, order_id: null,
        });
        expect(await accountState(userId)).toEqual(before);
    });

    it("a new episode (closed and reopened) gets its own row", async () => {
        await order(userId, "BUY", SIZE, 10);
        seedReferenceBook(pairId, "75000", "75000");
        const engine = newEngine();
        await evaluateTwice(engine);

        seedReferenceBook(pairId, "83000", "83000");
        await order(userId, "SELL", SIZE);
        await order(userId, "BUY", SIZE, 10);
        expect((await position(userId)).epoch).toBe(2);

        seedReferenceBook(pairId, "75000", "75000");
        await evaluateTwice(engine, Date.now() + 2_000);
        expect((await liquidations(userId)).map((r) => [r.mode, r.position_epoch])).toEqual([["LOG_ONLY", 1], ["LOG_ONLY", 2]]);
    });
});

describe("off", () => {
    it("evaluates nothing and writes nothing, even on a breach", async () => {
        setup("execute");
        await order(userId, "BUY", SIZE, 10);
        config.leverage.liquidationMode = "off";
        seedReferenceBook(pairId, "60000", "60000");
        const [a, b] = await evaluateTwice(newEngine());
        expect(a).toEqual({ status: "off" });
        expect(b).toEqual({ status: "off" });
        expect(await liquidations(userId)).toEqual([]);
        expect((await position(userId)).base_qty).toBe(SIZE);
    });
});

describe("a stale price never liquidates", () => {
    beforeEach(() => setup("execute"));

    it("krakenWs not ok: paused, one SKIPPED_STALE row, position intact; resumes and liquidates when the feed is back", async () => {
        await order(userId, "BUY", SIZE, 10);
        seedReferenceBook(pairId, "75000", "75000");
        const engine = newEngine();
        feed = "stale";
        const t0 = Date.now();
        for (let i = 0; i < 5; i++) {
            expect(await engine.evaluatePair(pairId, t0 + i * 600)).toMatchObject({ status: "paused", feed: "stale" });
        }
        const rows = await liquidations(userId);
        expect(rows.map((r) => r.mode)).toEqual(["SKIPPED_STALE"]);
        expect(rows[0]).toMatchObject({ mark_price: "75000.00000000", fill_price: null, order_id: null });
        expect((await position(userId)).base_qty).toBe(SIZE);

        // Feed back: the confirmation starts over, then it closes.
        feed = "ok";
        seedReferenceBook(pairId, "75000", "75000");
        // (the clock stays within the book's max age: a later `now` would make it stale)
        const [a, b] = await evaluateTwice(engine, Date.now() + 3_000);
        expect(a).toMatchObject({ status: "evaluated", pending: 1, executed: 0 });
        expect(b).toMatchObject({ executed: 1 });
        expect((await liquidations(userId)).map((r) => r.mode)).toEqual(["SKIPPED_STALE", "EXECUTED"]);
    });

    it("a book older than MARKET_COLLAR_MAX_BOOK_AGE_MS pauses the pair even while krakenWs says ok", async () => {
        await order(userId, "BUY", SIZE, 10);
        seedReferenceBook(pairId, "75000", "75000", config.marketCollarMaxBookAgeMs + 1_000);
        const [a, b] = await evaluateTwice(newEngine());
        expect(a).toMatchObject({ status: "paused" });
        expect(b).toMatchObject({ status: "paused" });
        expect((await position(userId)).base_qty).toBe(SIZE);
        expect((await liquidations(userId)).map((r) => r.mode)).toEqual(["SKIPPED_STALE"]);
    });

    it("the ticker alone (no book) never liquidates", async () => {
        await order(userId, "BUY", SIZE, 10);
        clearReferenceBooks();
        await seedTicker("BTC/USD", "60000", "60000");
        expect((await evaluateTwice(newEngine()))[1]).toMatchObject({ status: "paused" });
        expect(await liquidations(userId)).toEqual([]);
        expect((await position(userId)).base_qty).toBe(SIZE);
    });

    it("the matching engine itself refuses a liquidation on a stale book, even with a fresh ticker", async () => {
        await order(userId, "BUY", SIZE, 10);
        seedReferenceBook(pairId, "60000", "60000", config.marketCollarMaxBookAgeMs + 1_000);
        await seedTicker("BTC/USD", "60000", "60000");
        await expect(liquidate(userId, 1, "LONG")).rejects.toThrow("stale_price_source");
        expect((await position(userId)).base_qty).toBe(SIZE);
    });
});

describe("glitch guard", () => {
    beforeEach(() => setup("execute"));

    it("one breach followed by recovery does nothing; a breach must hold for two evaluations ≥ 500 ms apart", async () => {
        await order(userId, "BUY", SIZE, 10);
        const engine = newEngine();
        const t0 = Date.now();

        seedReferenceBook(pairId, "75000", "75000");
        expect(await engine.evaluatePair(pairId, t0)).toMatchObject({ pending: 1 });
        seedReferenceBook(pairId, "83000", "83000");
        expect(await engine.evaluatePair(pairId, t0 + 300)).toMatchObject({ candidates: 0 });
        seedReferenceBook(pairId, "75000", "75000");
        expect(await engine.evaluatePair(pairId, t0 + 600)).toMatchObject({ pending: 1, executed: 0 }); // starts over
        expect(await engine.evaluatePair(pairId, t0 + 1_000)).toMatchObject({ pending: 1, executed: 0 }); // 400 ms: too soon
        expect(await engine.evaluatePair(pairId, t0 + 1_100)).toMatchObject({ executed: 1 });
        expect((await liquidations(userId)).map((r) => r.mode)).toEqual(["EXECUTED"]);
    });
});

describe("bots and @system.local users are never liquidated", () => {
    async function systemUserBreaching(): Promise<string> {
        const bot = await newTrader("1000.00000000", `liq-bot-${Date.now()}@system.local`);
        // A system user can't open ISOLATED; force the row as if it had.
        await pool.query(
            `INSERT INTO positions (user_id, pair_id, base_qty, avg_entry_price, margin_mode, leverage, isolated_margin, liq_price, epoch)
             VALUES ($1, $2, $3, 83000, 'ISOLATED', 10, $4, 75075.37688442, 1)`,
            [bot, pairId, SIZE, MARGIN],
        );
        return bot;
    }

    it.each(["execute", "log_only"] as const)("%s: no row, no order", async (mode) => {
        setup(mode);
        const bot = await systemUserBreaching();
        seedReferenceBook(pairId, "70000", "70000");
        const [, b] = await evaluateTwice(newEngine());
        expect(b).toMatchObject({ candidates: 1, pending: 0, executed: 0, logged: 0 });
        expect(await liquidations(bot)).toEqual([]);
        const { rows } = await pool.query(`SELECT 1 FROM orders WHERE user_id = $1`, [bot]);
        expect(rows).toHaveLength(0);
    });

    it("the matching engine refuses one too", async () => {
        setup("execute");
        const bot = await systemUserBreaching();
        seedReferenceBook(pairId, "70000", "70000");
        await expect(liquidate(bot, 1, "LONG")).rejects.toThrow("liquidation_not_needed");
    });
});

describe("the matching engine's re-check", () => {
    beforeEach(() => setup("execute"));

    it("no breach at the book read under the pair lock → no-op", async () => {
        await order(userId, "BUY", SIZE, 10);
        seedReferenceBook(pairId, "76000", "76000");
        await expect(liquidate(userId, 1, "LONG")).rejects.toMatchObject({ message: "liquidation_not_needed", reason: "no_breach" });
        expect((await position(userId)).base_qty).toBe(SIZE);
    });

    it("another episode → no-op, even if the new one breaches", async () => {
        await order(userId, "BUY", SIZE, 10);
        await order(userId, "SELL", SIZE);
        await order(userId, "BUY", SIZE, 10); // epoch 2
        seedReferenceBook(pairId, "70000", "70000");
        await expect(liquidate(userId, 1, "LONG")).rejects.toMatchObject({ reason: "epoch_changed" });
        expect((await position(userId)).base_qty).toBe(SIZE);
        await liquidate(userId, 2, "LONG");
        expect((await liquidations(userId)).map((r) => r.position_epoch)).toEqual([2]);
    });

    it("the wrong side → no-op", async () => {
        await order(userId, "BUY", SIZE, 10);
        seedReferenceBook(pairId, "95000", "95000");
        await expect(liquidate(userId, 1, "SHORT")).rejects.toMatchObject({ reason: "side_changed" });
    });

    it("closes the size under the lock, not the engine's: a partial close in between leaves less to liquidate", async () => {
        await order(userId, "BUY", SIZE, 10);
        await order(userId, "SELL", "0.00301205"); // ~half; liq unchanged
        seedReferenceBook(pairId, "75000", "75000");
        const res = await liquidate(userId, 1, "LONG", SIZE);
        expect(res.liquidation?.qty).toBe("0.00301204");
        expect(res.order.qty).toBe("0.00301204");
        expect((await position(userId)).base_qty).toBe("0.00000000");
    });

    it("an add that moves the liq price below the mark → no-op", async () => {
        await order(userId, "BUY", SIZE, 10);
        seedReferenceBook(pairId, "75000", "75000");
        await order(userId, "BUY", "0.0133", 10); // $133 at 10x at 75,000
        const p = await position(userId);
        expect(new Decimal(p.liq_price!).lt(75000)).toBe(true);
        await expect(liquidate(userId, 1, "LONG")).rejects.toMatchObject({ reason: "no_breach" });
    });
});
