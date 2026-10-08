/**
 * GET /v1/pairs/:pairId/candles — the latest page ends with the forming
 * bucket (`partial: true`); `limit` counts finished candles only; a `before`
 * page never has one. Real test DB, every timeframe.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../app";
import { pool } from "../../../db/pool";
import { ensureMigrations } from "../../../testing/resetDb";
import { createCandleFixturePair, insertCandles, minuteRows, aggregate } from "../../../testing/candleFixtures";
import { aggregateTick, __resetCandleAggregatorForTest } from "../../../market/candleAggregator";
import { bucketStartMs, TIMEFRAME_SECONDS } from "../../../market/formingCandle";

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"] as const;

describe("GET /v1/pairs/:pairId/candles forming candle", () => {
    let app: FastifyInstance;
    let headers: Record<string, string>;
    let fx: Awaited<ReturnType<typeof createCandleFixturePair>>;

    beforeAll(async () => {
        await ensureMigrations();
        app = await buildApp({
            logger: false,
            disableKrakenFeed: true,
            disableTriggerEngine: true,
            disableJobRunner: true,
            disableOutboxWorker: true,
            disableLockSampler: true,
            disableOrchestrator: true,
        });
        await app.ready();
        headers = { authorization: `Bearer ${app.jwt.sign({ sub: "00000000-0000-4000-8000-000000000001", role: "USER" }, { expiresIn: 3600 })}` };
    });
    afterAll(async () => {
        await app.close();
    });
    beforeEach(async () => {
        __resetCandleAggregatorForTest();
        fx = await createCandleFixturePair(pool, "RT");
    });
    afterEach(async () => {
        await fx.cleanup();
    });

    it.each(TIMEFRAMES)("%s: limit finished candles + the forming bucket opening at the previous close", async (tf) => {
        const tfMs = TIMEFRAME_SECONDS[tf]! * 1000;
        const now = Date.now();
        const B = bucketStartMs(now, tf);
        // Five finished bars, a stray stored row for the current bucket, and
        // stored 1m minutes from the previous bucket's last minute on.
        await insertCandles(pool, fx.pairId, tf, [1, 2, 3, 4, 5].map((i) => ({
            tsMs: B - i * tfMs, open: 10 * i, high: 10 * i + 5, low: 10 * i - 5, close: 10 * i + 1, volume: i,
        })).concat(tf === "1m" ? [] : [{ tsMs: B, open: 7, high: 7, low: 7, close: 7, volume: 7 }]));
        const lastMinute = Math.floor(now / 60_000) * 60_000;
        // For 1m the timeframe rows ARE the 1m rows: the previous close is bar B − 1m's (11).
        const prevClose = tf === "1m" ? 11 : 42;
        if (tf !== "1m") {
            await insertCandles(pool, fx.pairId, "1m", [{ tsMs: B - 60_000, open: 50, high: 50, low: 50, close: 42, volume: 1 }]);
            await insertCandles(pool, fx.pairId, "1m", minuteRows(B, lastMinute, () => 40));
        }

        const res = await app.inject({ method: "GET", url: `/v1/pairs/${fx.pairId}/candles?timeframe=${tf}&limit=3`, headers });
        expect(res.statusCode).toBe(200);
        const candles = res.json().candles as Array<{ ts: string; open: string; high: string; low: string; close: string; partial?: boolean }>;

        expect(candles).toHaveLength(4);
        expect(candles.slice(0, 3).map((c) => new Date(c.ts).getTime())).toEqual([B - 3 * tfMs, B - 2 * tfMs, B - tfMs]);
        expect(candles.slice(0, 3).every((c) => c.partial === undefined)).toBe(true);

        const forming = candles[3]!;
        expect(forming.partial).toBe(true);
        expect(new Date(forming.ts).getTime()).toBe(B);
        expect(Number(forming.open)).toBe(prevClose); // previous close, not the stray row
        if (tf === "1m") {
            // Bucket = the current minute: no ticks in this test → flat at the previous close.
            expect([forming.high, forming.low, forming.close].map(Number)).toEqual([11, 11, 11]);
        } else if (lastMinute > B) {
            expect(Number(forming.close)).toBe(41);
            expect(Number(forming.high)).toBe(43);
            expect(Number(forming.low)).toBe(38);
        } else {
            expect([forming.high, forming.low, forming.close].map(Number)).toEqual([42, 42, 42]);
        }
    });

    it.each(TIMEFRAMES.filter((t) => t !== "1m"))(
        "%s: a just-finished bucket the rollup hasn't stored yet is filled from 1m — no missing bar",
        async (tf) => {
            const tfMs = TIMEFRAME_SECONDS[tf]! * 1000;
            const now = Date.now();
            const B = bucketStartMs(now, tf);
            // Stored bars stop two buckets back; the previous bucket only has 1m rows.
            await insertCandles(pool, fx.pairId, tf, [{ tsMs: B - 2 * tfMs, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }]);
            const prev1m = minuteRows(B - tfMs, B);
            await insertCandles(pool, fx.pairId, "1m", prev1m);

            const res = await app.inject({ method: "GET", url: `/v1/pairs/${fx.pairId}/candles?timeframe=${tf}&limit=5`, headers });
            const candles = res.json().candles as Array<{ ts: string; open: string; high: string; low: string; close: string; volume: string; partial?: boolean }>;
            expect(candles.map((c) => new Date(c.ts).getTime())).toEqual([B - 2 * tfMs, B - tfMs, B]);
            const filled = candles[1]!;
            const a = aggregate(prev1m);
            expect(filled.partial).toBeUndefined();
            expect([filled.open, filled.high, filled.low, filled.close, filled.volume].map(Number)).toEqual([a.open, a.high, a.low, a.close, a.volume]);
            expect(candles[2]!.partial).toBe(true);
            expect(Number(candles[2]!.open)).toBe(a.close); // forming opens at the filled bar's close
        },
    );

    it("1m: the finished minute still in memory (stored on the next tick) is returned — no gap at :00", async () => {
        const now = Date.now();
        const B = bucketStartMs(now, "1m");
        await insertCandles(pool, fx.pairId, "1m", [{ tsMs: B - 120_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }]);
        // Minute B − 1m only in the aggregator: no tick in minute B has rolled it yet.
        aggregateTick(fx.pairId, { price: "101", volume: "1", ts: B - 50_000 });
        aggregateTick(fx.pairId, { price: "104", volume: "2", ts: B - 20_000 });

        const res = await app.inject({ method: "GET", url: `/v1/pairs/${fx.pairId}/candles?timeframe=1m&limit=5`, headers });
        const candles = res.json().candles as Array<{ ts: string; open: string; high: string; low: string; close: string; volume: string; partial?: boolean }>;
        expect(candles.map((c) => new Date(c.ts).getTime())).toEqual([B - 120_000, B - 60_000, B]);
        expect(candles[1]!.partial).toBeUndefined();
        expect([candles[1]!.open, candles[1]!.high, candles[1]!.low, candles[1]!.close, candles[1]!.volume].map(Number)).toEqual([101, 104, 101, 104, 3]);
        expect(candles[2]!.partial).toBe(true);
        expect(Number(candles[2]!.open)).toBe(104);
    });

    it("a `before` page has no forming candle", async () => {
        const now = Date.now();
        const B = bucketStartMs(now, "1h");
        await insertCandles(pool, fx.pairId, "1h", [1, 2, 3].map((i) => ({ tsMs: B - i * 3_600_000, open: 1, high: 1, low: 1, close: 1, volume: 1 })));
        const res = await app.inject({
            method: "GET",
            url: `/v1/pairs/${fx.pairId}/candles?timeframe=1h&before=${encodeURIComponent(new Date(B - 3_600_000).toISOString())}`,
            headers,
        });
        const candles = res.json().candles as Array<{ partial?: boolean }>;
        expect(candles).toHaveLength(2);
        expect(candles.some((c) => c.partial)).toBe(false);
    });

    it("a pair with no data returns no candles (no forming row out of nothing)", async () => {
        const res = await app.inject({ method: "GET", url: `/v1/pairs/${fx.pairId}/candles?timeframe=1h`, headers });
        expect(res.json().candles).toEqual([]);
    });
});
