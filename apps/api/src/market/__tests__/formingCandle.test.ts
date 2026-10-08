/**
 * formingCandle.test.ts — the in-progress candle for every timeframe, built
 * from the bucket's stored 1m rows + the aggregator's open minute, opening at
 * the previous close. Real test DB; real candle aggregator.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pool } from "../../db/pool";
import { aggregateTick, seedOpenCandle, __resetCandleAggregatorForTest } from "../candleAggregator";
import { bucketStartMs, getFormingCandle, getUnrolledBuckets, MAX_UNROLLED_BUCKETS, seedOpenCandlesFromKrakenRest, TIMEFRAME_SECONDS } from "../formingCandle";
import { createCandleFixturePair, insertCandles, minuteRows, aggregate } from "../../testing/candleFixtures";
import type { OHLCPage } from "../krakenRest";

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"] as const;

// Monday 2026-10-05 00:00 UTC: a boundary for every timeframe, incl. ISO weeks.
const MONDAY = Date.UTC(2026, 9, 5);

describe("bucketStartMs", () => {
    it.each(TIMEFRAMES)("%s: floors to the bucket start", (tf) => {
        const ms = TIMEFRAME_SECONDS[tf]! * 1000;
        const b = MONDAY + ms * 2;
        expect(bucketStartMs(b, tf)).toBe(b);
        expect(bucketStartMs(b + ms - 1, tf)).toBe(b);
        expect(bucketStartMs(b + ms, tf)).toBe(b + ms);
    });

    it("1w buckets start Monday 00:00 UTC", () => {
        expect(bucketStartMs(MONDAY + 3 * 86_400_000 + 5_000, "1w")).toBe(MONDAY);
    });
});

describe.each(TIMEFRAMES)("getFormingCandle — %s", (tf) => {
    const tfMs = TIMEFRAME_SECONDS[tf]! * 1000;
    // Bucket starts on a Monday boundary; "now" is mid-bucket, 50s into a minute.
    const B = MONDAY + 7 * 86_400_000;
    const now = B + Math.floor(tfMs / 2 / 60_000) * 60_000 + 50_000;
    const curMin = Math.floor(now / 60_000) * 60_000;
    const PREV_CLOSE = 104.5;
    let fx: Awaited<ReturnType<typeof createCandleFixturePair>>;

    beforeEach(async () => {
        __resetCandleAggregatorForTest();
        fx = await createCandleFixturePair(pool, "FC");
    });
    afterEach(async () => {
        await fx.cleanup();
    });

    async function seedPrevMinute(close = PREV_CLOSE) {
        await insertCandles(pool, fx.pairId, "1m", [{ tsMs: B - 60_000, open: 99, high: 120, low: 90, close, volume: 5 }]);
    }

    it("opens at the previous close and aggregates stored minutes + the open minute", async () => {
        await seedPrevMinute();
        const stored = minuteRows(B, curMin);
        await insertCandles(pool, fx.pairId, "1m", stored);
        aggregateTick(fx.pairId, { price: "103", volume: "1", ts: curMin + 1_000 });
        aggregateTick(fx.pairId, { price: "111", volume: "1.5", ts: curMin + 2_000 });
        aggregateTick(fx.pairId, { price: "96", volume: "0.5", ts: curMin + 3_000 });
        aggregateTick(fx.pairId, { price: "101.25", volume: "1", ts: curMin + 4_000 });

        const f = await getFormingCandle(fx.pairId, tf, now);
        const s = stored.length ? aggregate(stored) : null;
        expect(f).not.toBeNull();
        expect(f!.partial).toBe(true);
        expect(new Date(f!.ts).getTime()).toBe(B);
        expect(Number(f!.open)).toBe(PREV_CLOSE);
        expect(Number(f!.high)).toBe(Math.max(PREV_CLOSE, s?.high ?? -Infinity, 111));
        expect(Number(f!.low)).toBe(Math.min(PREV_CLOSE, s?.low ?? Infinity, 96));
        expect(Number(f!.close)).toBe(101.25);
        expect(Number(f!.volume)).toBeCloseTo((s?.volume ?? 0) + 4, 9);
    });

    it("doesn't double-count the open minute once it's stored", async () => {
        await seedPrevMinute();
        const stored = minuteRows(B, curMin + 60_000);
        await insertCandles(pool, fx.pairId, "1m", stored);
        aggregateTick(fx.pairId, { price: "999", volume: "50", ts: curMin + 1_000 }); // same minute as the last stored row

        const f = (await getFormingCandle(fx.pairId, tf, now))!;
        const s = aggregate(stored);
        expect(Number(f.volume)).toBe(s.volume);
        expect(Number(f.close)).toBe(s.close);
        expect(Number(f.high)).toBe(Math.max(PREV_CLOSE, s.high));
    });

    it("range always contains the open (previous close above everything in the bucket)", async () => {
        await seedPrevMinute(500);
        await insertCandles(pool, fx.pairId, "1m", minuteRows(B, curMin));
        aggregateTick(fx.pairId, { price: "103", volume: "1", ts: curMin + 1_000 });

        const f = (await getFormingCandle(fx.pairId, tf, now))!;
        expect(Number(f.open)).toBe(500);
        expect(Number(f.high)).toBe(500);
        expect(Number(f.close)).toBe(103);
    });

    it("an empty bucket is a flat bar at the previous close", async () => {
        await seedPrevMinute();
        const f = (await getFormingCandle(fx.pairId, tf, now))!;
        expect([f.open, f.high, f.low, f.close].map(Number)).toEqual([PREV_CLOSE, PREV_CLOSE, PREV_CLOSE, PREV_CLOSE]);
        expect(Number(f.volume)).toBe(0);
    });

    it("no data at all → null", async () => {
        expect(await getFormingCandle(fx.pairId, tf, now)).toBeNull();
    });

    it("no 1m before the bucket → previous close from this timeframe's last bar", async () => {
        await insertCandles(pool, fx.pairId, tf, [{ tsMs: B - tfMs, open: 1, high: 400, low: 1, close: 321, volume: 9 }]);
        const f = (await getFormingCandle(fx.pairId, tf, now))!;
        expect(Number(f.open)).toBe(321);
    });

    it("the previous bar that ends latest wins", async () => {
        // Timeframe bar two buckets back (ends at B − tf) vs the last 1m (ends at B).
        await insertCandles(pool, fx.pairId, tf, [{ tsMs: B - 2 * tfMs, open: 1, high: 400, low: 1, close: 321, volume: 9 }]);
        await seedPrevMinute();
        expect(Number((await getFormingCandle(fx.pairId, tf, now))!.open)).toBe(PREV_CLOSE);
    });

    it("previous close from the aggregator when the last minute isn't readable yet", async () => {
        // Older stored 1m, then the minute before the bucket only in memory —
        // a tick in the bucket rolls it (closed, flush in flight).
        await insertCandles(pool, fx.pairId, "1m", [{ tsMs: B - 5 * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
        aggregateTick(fx.pairId, { price: "107", volume: "1", ts: B - 30_000 });
        aggregateTick(fx.pairId, { price: "108", volume: "1", ts: curMin + 1_000 });
        expect(Number((await getFormingCandle(fx.pairId, tf, now))!.open)).toBe(107);
    });
});

describe.each(TIMEFRAMES)("getUnrolledBuckets — %s", (tf) => {
    const tfMs = TIMEFRAME_SECONDS[tf]! * 1000;
    const B = MONDAY + 7 * 86_400_000;   // current bucket
    const now = B + 20_000;               // 20s into it: the previous minute may still be in memory
    let fx: Awaited<ReturnType<typeof createCandleFixturePair>>;

    beforeEach(async () => {
        __resetCandleAggregatorForTest();
        fx = await createCandleFixturePair(pool, "UB");
    });
    afterEach(async () => {
        await fx.cleanup();
    });

    it("previous bucket from stored 1m + the finished minute still in memory; nothing once it's stored as a bar", async () => {
        const stored = tf === "1m" ? [] : minuteRows(B - tfMs, B - 60_000);
        await insertCandles(pool, fx.pairId, "1m", stored);
        aggregateTick(fx.pairId, { price: "999", volume: "5", ts: B - 30_000 }); // last minute, not flushed

        const rows = await getUnrolledBuckets(fx.pairId, tf, B - 2 * tfMs, now);
        expect(rows.map((r) => new Date(r.ts).getTime())).toEqual([B - tfMs]);
        const r = rows[0]!;
        const a = stored.length ? aggregate(stored) : null;
        expect(Number(r.open)).toBe(a ? a.open : 999);
        expect(Number(r.high)).toBe(999);
        expect(Number(r.close)).toBe(999);
        expect(Number(r.volume)).toBe((a?.volume ?? 0) + 5);

        // Once that bucket's bar is stored, there's nothing to fill.
        expect(await getUnrolledBuckets(fx.pairId, tf, B - tfMs, now)).toEqual([]);
    });

    it("a stored last minute isn't counted twice", async () => {
        const stored = minuteRows(B - tfMs, B);
        await insertCandles(pool, fx.pairId, "1m", stored);
        aggregateTick(fx.pairId, { price: "999", volume: "5", ts: B - 30_000 }); // same minute as the last stored row
        const rows = await getUnrolledBuckets(fx.pairId, tf, B - 2 * tfMs, now);
        if (tf === "1m") {
            // 1m returns the in-memory minute itself (the route never has its stored row and memory at once).
            expect(rows).toHaveLength(1);
            return;
        }
        const a = aggregate(stored);
        expect([rows[0]!.high, rows[0]!.close, rows[0]!.volume].map(Number)).toEqual([a.high, a.close, a.volume]);
    });

    it("fills at most MAX_UNROLLED_BUCKETS, never the current bucket", async () => {
        await insertCandles(pool, fx.pairId, "1m", minuteRows(B - 4 * tfMs, now - 60_000 > B ? now - 60_000 : B));
        const rows = await getUnrolledBuckets(fx.pairId, tf, null, now);
        expect(rows.length).toBeLessThanOrEqual(MAX_UNROLLED_BUCKETS);
        expect(rows.every((r) => new Date(r.ts).getTime() < B)).toBe(true);
    });
});

describe("seedOpenCandlesFromKrakenRest", () => {
    const now = Date.UTC(2026, 9, 8, 14, 3, 25);
    const curMin = Date.UTC(2026, 9, 8, 14, 3, 0);
    const entry = (t: number, o: string) => ({ time: t / 1000, open: o, high: "110", low: "90", close: "101", volume: "7" });
    let fx: Awaited<ReturnType<typeof createCandleFixturePair>>;

    beforeEach(async () => {
        __resetCandleAggregatorForTest();
        fx = await createCandleFixturePair(pool, "SK");
    });
    afterEach(async () => {
        await fx.cleanup();
    });

    it("seeds the in-progress minute from Kraken's last entry; the forming 1m bar keeps that range", async () => {
        const page: OHLCPage = { candles: [entry(curMin - 60_000, "95"), entry(curMin, "100")], last: 0 };
        const fetchPage = vi.fn(async () => page);
        const seeded = await seedOpenCandlesFromKrakenRest(
            [{ pairId: fx.pairId, symbol: "BTC/USD" }, { pairId: "x", symbol: "DOGE/USD" }],
            fetchPage,
            () => now,
        );
        expect(seeded).toBe(1);
        expect(fetchPage).toHaveBeenCalledTimes(1); // DOGE/USD has no Kraken REST mapping
        expect(fetchPage).toHaveBeenCalledWith("XBTUSD", 1, Math.floor(now / 1000) - 120);

        aggregateTick(fx.pairId, { price: "102", volume: "1", ts: now });
        // A replayed trade for the previous minute is dropped (latestMinute set by the seed).
        aggregateTick(fx.pairId, { price: "1", volume: "1", ts: curMin - 1_000 });
        await insertCandles(pool, fx.pairId, "1m", [{ tsMs: curMin - 60_000, open: 95, high: 99, low: 94, close: 98, volume: 3 }]);

        const f = (await getFormingCandle(fx.pairId, "1m", now))!;
        expect([f.open, f.high, f.low, f.close].map(Number)).toEqual([98, 110, 90, 102]);
        expect(Number(f.volume)).toBe(8);
    });

    it("skips a last entry that isn't the current minute, and survives a failed fetch", async () => {
        const stale: OHLCPage = { candles: [entry(curMin - 60_000, "95")], last: 0 };
        expect(await seedOpenCandlesFromKrakenRest([{ pairId: fx.pairId, symbol: "ETH/USD" }], async () => stale, () => now)).toBe(0);
        const failing = async (): Promise<OHLCPage> => { throw new Error("HTTP 502"); };
        expect(await seedOpenCandlesFromKrakenRest([{ pairId: fx.pairId, symbol: "SOL/USD" }], failing, () => now)).toBe(0);
    });

    it("a seed arriving after live ticks merges: Kraken's open + range, live close", () => {
        aggregateTick(fx.pairId, { price: "105", volume: "1", ts: curMin + 20_000 });
        seedOpenCandle(fx.pairId, { minuteKey: curMin, open: "100", high: "104", low: "99", close: "103", volume: "6" });
        return getFormingCandle(fx.pairId, "1m", now).then((f) => {
            // No previous close stored → opens at the seeded open.
            expect([f!.open, f!.high, f!.low, f!.close].map(Number)).toEqual([100, 105, 99, 105]);
            expect(Number(f!.volume)).toBe(6);
        });
    });
});
