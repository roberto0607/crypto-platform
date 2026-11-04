/**
 * largeOrders.test.ts: realistic sizing through the real order pipeline.
 *
 *   sizing     no per-order liquidity rejection: a $1M MARKET fills, walking
 *              the book, as one system trade at the average, fee on it.
 *   small      inside the $50k touch band nothing changes: the touch, however
 *              thin the book.
 *   cap        trading_pairs.max_order_notional stops typos (MARKET and
 *              LIMIT); reduce-only closes and system users are exempt.
 *   stale      no depth (ticker reference): inside the band fills as before,
 *              above it rejects; a trigger re-arms.
 *   liquidate  a $1M 10x liquidation walks the book; the loss cap holds.
 *
 * Real Postgres; the Kraken book is seeded in-process. BTC/USD taker 5 bps,
 * MMR 50 bps. Book: 2 @ 100,000, 3 @ 100,010, 5 @ 100,020, 90 @ 100,100.
 * 10 BTC ($1M): 0.5 band + 1.5 + 3 + 5 → 1,000,130 / 10 = 100,013.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { pool } from "../../db/pool";
import { config } from "../../config";
import { D } from "../../utils/decimal";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedDepthBook, seedReferenceBook, clearReferenceBooks, seedTicker } from "../../testing/referenceBook";
import { placeOrderWithSnapshot } from "../phase6OrderService";
import { LiquidationEngine } from "../liquidationEngine";
import { quoteMarketOrder } from "../marketQuote";

let pairId: string;
let btcAssetId: string;
let usdAssetId: string;

const savedLeverage = { ...config.leverage };

const ASKS: [number, number][] = [[100_000, 2], [100_010, 3], [100_020, 5], [100_100, 90]];
const BIDS: [number, number][] = [[99_990, 2], [99_980, 3], [99_970, 5], [99_890, 90]];

function enableLeverage(mode: "log_only" | "execute" = "log_only") {
    Object.assign(config.leverage, {
        enabled: true, liquidationMode: mode, maxFreePlay: 10, maxMatch: 5, maxCompetition: 1, allowlist: [],
    });
}

async function trader(usd: string, btc = "0.00000000", email?: string): Promise<string> {
    const u = await createTestUser(pool, email ? { email } : {});
    await createTestWallets(pool, u.id, btcAssetId, usdAssetId, btc, usd);
    return u.id;
}

const market = (uid: string, side: "BUY" | "SELL", qty: string, extra: { leverage?: number; reduceOnly?: boolean } = {}) =>
    placeOrderWithSnapshot(uid, { pairId, side, type: "MARKET", qty, ...extra });

async function usd(uid: string): Promise<string> {
    const { rows } = await pool.query<{ balance: string }>(
        `SELECT balance::text FROM wallets WHERE user_id = $1 AND asset_id = $2 AND competition_id IS NULL AND match_id IS NULL`,
        [uid, usdAssetId],
    );
    return rows[0].balance;
}

async function position(uid: string) {
    const { rows } = await pool.query<{ base_qty: string; avg_entry_price: string; isolated_margin: string; liq_price: string | null; epoch: number }>(
        `SELECT base_qty::text, avg_entry_price::text, isolated_margin::text, liq_price::text, epoch FROM positions
         WHERE user_id = $1 AND pair_id = $2 AND competition_id IS NULL AND match_id IS NULL`,
        [uid, pairId],
    );
    return rows[0];
}

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
    await pool.query(`UPDATE trading_pairs SET last_price = '100000' WHERE id = $1`, [pairId]);
    seedDepthBook(pairId, BIDS, ASKS);
});

afterEach(() => {
    Object.assign(config.leverage, savedLeverage);
});

describe("sizing", () => {
    it("$1M BTC at 10x fills, one system trade at the walked average, fee on the actual fill", async () => {
        enableLeverage();
        const u = await trader("200000.00000000");
        const r = await market(u, "BUY", "10.00000000", { leverage: 10 });

        expect(r.order.status).toBe("FILLED");
        expect(r.fills).toHaveLength(1);
        expect(r.fills[0].is_system_fill).toBe(true);
        expect(D(r.fills[0].price).toNumber()).toBe(100_013);
        expect(D(r.fills[0].quote_amount).toNumber()).toBe(1_000_130);
        expect(D(r.fills[0].fee_amount).toNumber()).toBeCloseTo(500.065, 6);

        const p = await position(u);
        expect(D(p.avg_entry_price).toNumber()).toBe(100_013);
        expect(D(p.isolated_margin).toNumber()).toBe(100_013);
        // 200,000 − 100,013 margin − 500.065 fee.
        expect(D(await usd(u)).toNumber()).toBeCloseTo(99_486.935, 6);
    });

    it("a $1M SELL walks the bid the same way", async () => {
        enableLeverage();
        const u = await trader("200000.00000000");
        const r = await market(u, "SELL", "10.00000000", { leverage: 10 });
        // 0.50005 band... at 99,990: 50,000 quote, then the book from there.
        expect(D(r.fills[0].price).toNumber()).toBeLessThan(99_990);
        expect(D(r.fills[0].price).toNumber()).toBeGreaterThan(99_970);
    });

    it("leverage off: a $1M spot BUY fills at the same walked price", async () => {
        const u = await trader("2000000.00000000");
        const r = await market(u, "BUY", "10.00000000");
        expect(D(r.fills[0].price).toNumber()).toBe(100_013);
    });

    it("the quiet-minute $10k limit is gone: a $40k order fills whatever the 1m candle's volume", async () => {
        const u = await trader("100000.00000000");
        await pool.query(
            `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
             VALUES ($1, '1m', now() - interval '1 minute', 100000, 100000, 100000, 100000, 0.01)`,
            [pairId],
        );
        const r = await market(u, "BUY", "0.40000000");
        expect(r.order.status).toBe("FILLED");
    });

    it("a fill walked past the collar leaves trading_pairs.last_price alone", async () => {
        const u = await trader("20000000.00000000");
        seedDepthBook(pairId, BIDS, [[100_000, 1], [103_000, 100]]);
        const r = await market(u, "BUY", "10.00000000");
        expect(D(r.fills[0].price).toNumber()).toBeGreaterThan(100_250);
        const { rows } = await pool.query<{ last_price: string }>(`SELECT last_price::text FROM trading_pairs WHERE id = $1`, [pairId]);
        expect(D(rows[0].last_price).toNumber()).toBe(100_000);
    });
});

describe("small orders (touch band)", () => {
    it("$50k and under fills exactly at the touch, even on a one-level book", async () => {
        const u = await trader("100000.00000000");
        seedReferenceBook(pairId, "99990", "100000"); // qty 1 per side
        const r = await market(u, "BUY", "0.50000000");
        expect(r.fills[0].price).toBe("100000.00000000");
    });

    it("internal resting orders still fill first, then the remainder pays the model", async () => {
        const maker = await trader("0.00000000", "5.00000000");
        const u = await trader("2000000.00000000");
        await placeOrderWithSnapshot(maker, { pairId, side: "SELL", type: "LIMIT", qty: "1.00000000", limitPrice: "99995" });
        const r = await market(u, "BUY", "10.00000000");
        expect(r.fills).toHaveLength(2);
        expect(r.fills[0].price).toBe("99995.00000000");
        expect(r.fills[1].is_system_fill).toBe(true);
        expect(D(r.fills[1].qty).toNumber()).toBe(9);
    });
});

describe("max order notional", () => {
    it("$10M rejects naming the cap; nothing is written", async () => {
        const u = await trader("20000000.00000000");
        await expect(market(u, "BUY", "100.00000000")).rejects.toMatchObject({
            code: "order_too_large",
            details: { maxNotional: "5000000.00", requestedNotional: "10000000.00", symbol: "BTC/USD" },
        });
        const { rows } = await pool.query(`SELECT 1 FROM orders WHERE user_id = $1`, [u]);
        expect(rows).toHaveLength(0);
    });

    it("exactly at the cap passes", async () => {
        const u = await trader("20000000.00000000");
        const r = await market(u, "BUY", "50.00000000");
        expect(r.order.status).toBe("FILLED");
    });

    it("applies to LIMIT orders too, at their limit price", async () => {
        const u = await trader("20000000.00000000");
        await expect(
            placeOrderWithSnapshot(u, { pairId, side: "BUY", type: "LIMIT", qty: "100.00000000", limitPrice: "90000" }),
        ).rejects.toMatchObject({ code: "order_too_large", details: { requestedNotional: "9000000.00" } });
    });

    it("is per pair", async () => {
        await pool.query(`UPDATE trading_pairs SET max_order_notional = 2000000 WHERE id = $1`, [pairId]);
        const u = await trader("20000000.00000000");
        await expect(market(u, "BUY", "30.00000000")).rejects.toMatchObject({
            code: "order_too_large", details: { maxNotional: "2000000.00" },
        });
    });

    it("a position past the cap can always be closed: reduce-only is exempt", async () => {
        enableLeverage();
        const u = await trader("2000000.00000000");
        await market(u, "BUY", "10.00000000", { leverage: 10 });
        await pool.query(`UPDATE trading_pairs SET max_order_notional = 100000 WHERE id = $1`, [pairId]);
        const r = await market(u, "SELL", "10.00000000", { reduceOnly: true });
        expect(r.order.status).toBe("FILLED");
    });

    it("system users are exempt", async () => {
        const bot = await trader("20000000.00000000", "0.00000000", "bigbot@system.local");
        const r = await placeOrderWithSnapshot(bot, { pairId, side: "BUY", type: "LIMIT", qty: "100.00000000", limitPrice: "90000" });
        expect(r.order.status).toBe("OPEN");
    });
});

describe("stale book (ticker reference, no depth)", () => {
    beforeEach(async () => {
        clearReferenceBooks();
        await seedTicker("BTC/USD", "99990", "100000", "100000");
    });

    it("inside the band: fills at the ticker touch, as today", async () => {
        const u = await trader("100000.00000000");
        const r = await market(u, "BUY", "0.40000000");
        expect(r.fills[0].price).toBe("100000.00000000");
    });

    it("above the band: rejects with its own error, nothing moves", async () => {
        const u = await trader("100000.00000000");
        await expect(market(u, "BUY", "0.60000000")).rejects.toThrow("book_stale_for_size");
        expect(D(await usd(u)).toNumber()).toBe(100_000);
        const { rows } = await pool.query(`SELECT 1 FROM orders WHERE user_id = $1`, [u]);
        expect(rows).toHaveLength(0);
    });
});

describe("stale book: anything that only shrinks a position still fills", () => {
    /** A $1M 10x long, then the book goes stale. */
    async function longThenStale(): Promise<string> {
        enableLeverage();
        const u = await trader("2000000.00000000");
        await market(u, "BUY", "10.00000000", { leverage: 10 });
        clearReferenceBooks();
        await seedTicker("BTC/USD", "99990", "100000", "100000");
        return u;
    }

    it("a CLOSE (reduce-only) fills at the touch, position flat", async () => {
        const u = await longThenStale();
        const r = await market(u, "SELL", "10.00000000", { reduceOnly: true });
        expect(r.fills[0].price).toBe("99990.00000000");
        expect(D((await position(u)).base_qty).toNumber()).toBe(0);
    });

    it("a plain opposite-side order that only reduces fills at the touch", async () => {
        const u = await longThenStale();
        const r = await market(u, "SELL", "6.00000000");
        expect(r.fills[0].price).toBe("99990.00000000");
        expect(D((await position(u)).base_qty).toNumber()).toBe(4);
    });

    it("exactly closing without the flag fills too", async () => {
        const u = await longThenStale();
        await market(u, "SELL", "10.00000000");
        expect(D((await position(u)).base_qty).toNumber()).toBe(0);
    });

    it("a flip opens something, so it rejects", async () => {
        const u = await longThenStale();
        await expect(market(u, "SELL", "11.00000000")).rejects.toThrow("book_stale_for_size");
        expect(D((await position(u)).base_qty).toNumber()).toBe(10);
    });

    it("adding to the position rejects", async () => {
        const u = await longThenStale();
        await expect(market(u, "BUY", "1.00000000")).rejects.toThrow("book_stale_for_size");
    });

    it("SPOT: selling a holding fills at the touch; a short past it rejects", async () => {
        const u = await trader("2000000.00000000");
        await market(u, "BUY", "10.00000000");
        clearReferenceBooks();
        await seedTicker("BTC/USD", "99990", "100000", "100000");
        await expect(market(u, "SELL", "11.00000000")).rejects.toThrow("book_stale_for_size");
        const r = await market(u, "SELL", "10.00000000");
        expect(r.fills[0].price).toBe("99990.00000000");
    });

    it("the quote agrees when asked about a reducing order", async () => {
        const u = await longThenStale();
        expect(await quoteMarketOrder({ userId: u, pairId, side: "SELL", qty: "10.00000000", reduces: true }))
            .toMatchObject({ executable: true, estimatedPrice: "99990.00000000" });
        expect(await quoteMarketOrder({ userId: u, pairId, side: "SELL", qty: "10.00000000" }))
            .toMatchObject({ executable: false, reason: "book_stale_for_size" });
    });
});

describe("quote (the order panel's preview)", () => {
    const quote = (uid: string, q: Omit<Parameters<typeof quoteMarketOrder>[0], "userId" | "pairId">) =>
        quoteMarketOrder({ userId: uid, pairId, ...q });

    it.each([
        ["BUY", "0.10000000"], ["BUY", "1.00000000"], ["BUY", "10.00000000"], ["BUY", "50.00000000"],
        ["SELL", "0.10000000"], ["SELL", "1.00000000"], ["SELL", "10.00000000"], ["SELL", "50.00000000"],
    ] as const)("%s %s: the estimate is within 1 bps of the fill on a static book", async (side, qty) => {
        const u = await trader("20000000.00000000");
        const q = await quote(u, { side, qty });
        const r = await market(u, side, qty);
        expect(q.executable).toBe(true);
        const fill = D(r.fills[0].price).toNumber();
        expect(Math.abs(Number(q.estimatedPrice) / fill - 1) * 10_000).toBeLessThan(1);
        expect(Number(q.feeQuote)).toBeCloseTo(Number(r.fills[0].fee_amount), 6);
        expect(Number(q.requestedNotional)).toBeCloseTo(Number(r.fills[0].quote_amount), 4);
    });

    it("$1M: slippage in bps and dollars, from the touch", async () => {
        const u = await trader("100000.00000000");
        const q = await quote(u, { side: "BUY", qty: "10.00000000" });
        expect(q).toMatchObject({ touchPrice: "100000.00000000", estimatedPrice: "100013.00000000", maxOrderNotional: "5000000.00" });
        expect(Number(q.slippage_bps)).toBeCloseTo(1.3, 6);
        expect(Number(q.slippageQuote)).toBeCloseTo(130, 6);
    });

    it("counts the internal resting orders the fill would take first", async () => {
        const maker = await trader("0.00000000", "5.00000000");
        const u = await trader("2000000.00000000");
        await placeOrderWithSnapshot(maker, { pairId, side: "SELL", type: "LIMIT", qty: "1.00000000", limitPrice: "99995" });
        const q = await quote(u, { side: "BUY", qty: "10.00000000" });
        const r = await market(u, "BUY", "10.00000000");
        const paid = r.fills.reduce((sum, f) => sum + Number(f.quote_amount), 0);
        expect(Number(q.requestedNotional)).toBeCloseTo(paid, 4);
    });

    it("says why not: over the cap, stale book for the size, no price at all", async () => {
        const u = await trader("100000.00000000");
        expect(await quote(u, { side: "BUY", qty: "100.00000000" })).toMatchObject({ executable: false, reason: "order_too_large" });

        clearReferenceBooks();
        await seedTicker("BTC/USD", "99990", "100000", "100000");
        expect(await quote(u, { side: "BUY", qty: "0.40000000" })).toMatchObject({ executable: true, estimatedPrice: "100000.00000000" });
        expect(await quote(u, { side: "BUY", qty: "0.60000000" })).toMatchObject({ executable: false, reason: "book_stale_for_size" });

        clearReferenceBooks();
        expect(await quote(u, { side: "BUY", qty: "0.10000000" })).toMatchObject({ executable: false, reason: "stale_price_source" });
    });

    it("MAX: all of a $100k account at 10x, and the order it sizes is never rejected", async () => {
        enableLeverage();
        const u = await trader("100000.00000000");
        const q = await quote(u, { side: "BUY", budget: "100000", leverage: 10 });
        expect(Number(q.requestedNotional)).toBeGreaterThan(985_000);
        expect(Number(q.requestedNotional)).toBeLessThan(1_000_000);
        const r = await market(u, "BUY", q.qty, { leverage: 10 });
        expect(r.order.status).toBe("FILLED");
        expect(D(await usd(u)).toNumber()).toBeGreaterThanOrEqual(0);
    });

    it("MAX survives the price moving up to the buffer between the click and the fill", async () => {
        enableLeverage();
        const u = await trader("100000.00000000");
        const q = await quote(u, { side: "BUY", budget: "100000", leverage: 10 });
        const up = (l: [number, number][]): [number, number][] => l.map(([p, n]) => [p * 1.002, n]);
        seedDepthBook(pairId, up(BIDS), up(ASKS));
        const r = await market(u, "BUY", q.qty, { leverage: 10 });
        expect(r.order.status).toBe("FILLED");
    });

    it("MAX is clamped to the cap and still fills", async () => {
        enableLeverage();
        const u = await trader("10000000.00000000");
        const q = await quote(u, { side: "BUY", budget: "10000000", leverage: 10 });
        expect(Number(q.qty) * 100_000).toBeLessThanOrEqual(5_000_000);
        expect(Number(q.qty) * 100_000).toBeGreaterThan(4_900_000);
        const r = await market(u, "BUY", q.qty, { leverage: 10 });
        expect(r.order.status).toBe("FILLED");
    });

    it("MAX with no depth stops at the touch band, so it isn't rejected", async () => {
        enableLeverage();
        const u = await trader("100000.00000000");
        clearReferenceBooks();
        await seedTicker("BTC/USD", "99990", "100000", "100000");
        const q = await quote(u, { side: "BUY", budget: "100000", leverage: 10 });
        expect(q.executable).toBe(true);
        expect(Number(q.requestedNotional)).toBeLessThanOrEqual(50_000);
        const r = await market(u, "BUY", q.qty, { leverage: 10 });
        expect(r.order.status).toBe("FILLED");
    });
});

describe("liquidation", () => {
    const engine = () => new LiquidationEngine({ feedStatus: () => "ok", useLeadership: false });
    const liquidateTwice = async (e: LiquidationEngine) => {
        const t0 = Date.now();
        await e.evaluatePair(pairId, t0);
        await e.evaluatePair(pairId, t0 + 600);
    };
    async function liqRow(uid: string) {
        const { rows } = await pool.query<{ mode: string; fill_price: string; realized_pnl: string; fee: string; returned_equity: string; shortfall: string }>(
            `SELECT mode, fill_price::text, realized_pnl::text, fee::text, returned_equity::text, shortfall::text
             FROM liquidations WHERE user_id = $1`,
            [uid],
        );
        return rows[0];
    }

    it("a $1M 10x long pays the walk on the way out; margin − loss − fee comes back, nothing negative", async () => {
        enableLeverage("execute");
        // Exactly the margin + fee: everything is in the position.
        const u = await trader("100513.06500000");
        await market(u, "BUY", "10.00000000", { leverage: 10 });
        expect(D(await usd(u)).toNumber()).toBeCloseTo(0, 2);

        const liq = D((await position(u)).liq_price!).toNumber();
        // Mark just through the liq price, 5 BTC at the touch then 95 ten below.
        const touch = Math.floor(liq) - 5;
        seedDepthBook(pairId, [[touch, 2], [touch - 10, 3], [touch - 20, 95]], [[touch + 2, 100]]);
        await liquidateTwice(engine());

        const row = await liqRow(u);
        expect(row.mode).toBe("EXECUTED");
        // Walked: 50k at the touch, then the book. Not the touch for all 10.
        expect(D(row.fill_price).toNumber()).toBeLessThan(touch);
        expect(D(row.fill_price).toNumber()).toBeGreaterThan(touch - 20);
        expect(D(await usd(u)).toNumber()).toBeGreaterThanOrEqual(0);
        expect(D(await usd(u)).toNumber()).toBeCloseTo(D(row.returned_equity).toNumber(), 6);
        expect(D((await position(u)).base_qty).toNumber()).toBe(0);
    });

    it("a thin book that walks past bankruptcy: the margin is lost and no more, the shortfall is booked", async () => {
        enableLeverage("execute");
        const u = await trader("100513.06500000");
        await market(u, "BUY", "10.00000000", { leverage: 10 });
        const margin = D((await position(u)).isolated_margin).toNumber();

        const liq = D((await position(u)).liq_price!).toNumber();
        const touch = Math.floor(liq) - 5;
        // Half a BTC at the touch and nothing behind it but 5% lower.
        seedDepthBook(pairId, [[touch, 0.6], [touch * 0.95, 100]], [[touch + 2, 100]]);
        await liquidateTwice(engine());

        const row = await liqRow(u);
        expect(row.mode).toBe("EXECUTED");
        expect(D(row.realized_pnl).toNumber()).toBeCloseTo(-margin, 6);
        expect(D(row.fee).toNumber()).toBe(0);
        expect(D(row.returned_equity).toNumber()).toBe(0);
        expect(D(row.shortfall).toNumber()).toBeGreaterThan(0);
        // The shortfall is exactly what the walk lost beyond the margin.
        const rawLoss = 10 * (100_013 - D(row.fill_price).toNumber());
        expect(D(row.shortfall).toNumber()).toBeCloseTo(rawLoss - margin, 4);
        expect(D(await usd(u)).toNumber()).toBeGreaterThanOrEqual(0);
    });

    it("a stale book still refuses to liquidate", async () => {
        enableLeverage("execute");
        const u = await trader("200000.00000000");
        await market(u, "BUY", "10.00000000", { leverage: 10 });
        clearReferenceBooks();
        await seedTicker("BTC/USD", "80000", "80000", "80000");
        const p = await position(u);
        await expect(
            placeOrderWithSnapshot(
                u, { pairId, side: "SELL", type: "MARKET", qty: "10.00000000" },
                undefined, undefined, null, null, "liquidation", { epoch: p.epoch, side: "LONG" },
            ),
        ).rejects.toThrow("stale_price_source");
        expect(D((await position(u)).base_qty).toNumber()).toBe(10);
    });
});
