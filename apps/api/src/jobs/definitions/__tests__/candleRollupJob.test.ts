/**
 * candleRollupJob.test.ts — every bucket touched by the last 15 minutes of 1m
 * history is re-aggregated each run, so Kraken REST's replacements of
 * recently finished minutes reach the higher timeframes. Real test DB.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pool } from "../../../db/pool";
import { ROLLUPS, rollupForPair, rollupSince, ROLLUP_LOOKBACK_MS } from "../candleRollupJob";
import { createCandleFixturePair, insertCandles, minuteRows, aggregate } from "../../../testing/candleFixtures";

const MONDAY = Date.UTC(2026, 9, 5); // boundary for every timeframe incl. ISO weeks

describe("rollupSince", () => {
    it.each(ROLLUPS.map((r) => [r.timeframe, r.minutes] as const))(
        "%s: starts at the bucket holding now − 15 min unless the latest stored bucket is older",
        (_tf, minutes) => {
            const bucketMs = minutes * 60_000;
            const B = MONDAY + 7 * 86_400_000;
            const now = new Date(B + 5 * 60_000); // 5 min into a bucket
            // now − 15 min is in the previous bucket for every timeframe ≥ 5m...
            const expectLookback = new Date(bucketMs > 15 * 60_000 ? B - bucketMs : Math.floor((now.getTime() - ROLLUP_LOOKBACK_MS) / bucketMs) * bucketMs);
            expect(rollupSince(new Date(B), now, minutes)).toEqual(expectLookback);
            // ...and an older latest bucket (a backlog) still wins.
            const old = new Date(B - 10 * bucketMs);
            expect(rollupSince(old, now, minutes)).toEqual(old);
        },
    );
});

describe.each(ROLLUPS.map((r) => [r.timeframe, r] as const))("rollupForPair — %s", (tf, rollup) => {
    const bucketMs = rollup.minutes * 60_000;
    const B = MONDAY + 14 * 86_400_000;        // current bucket start
    const now = new Date(B + 2 * 60_000);       // 2 min into it (mid-bucket even for 5m)
    const prevStart = B - bucketMs;              // previous (finished) bucket
    let fx: Awaited<ReturnType<typeof createCandleFixturePair>>;

    beforeEach(async () => {
        fx = await createCandleFixturePair(pool, "RU");
    });
    afterEach(async () => {
        await fx.cleanup();
    });

    async function stored(ts: number) {
        const { rows } = await pool.query<{ open: string; high: string; low: string; close: string; volume: string }>(
            `SELECT open::text, high::text, low::text, close::text, volume::text FROM candles
             WHERE pair_id = $1 AND timeframe = $2 AND ts = to_timestamp($3 / 1000.0)`,
            [fx.pairId, tf, ts],
        );
        return rows[0] ? Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)])) : null;
    }

    it("re-aggregates the bucket after Kraken REST replaces a minute in the 15-min lookback", async () => {
        const rows = minuteRows(prevStart, now.getTime() - 60_000);
        await insertCandles(pool, fx.pairId, "1m", rows);

        await rollupForPair(fx.pairId, rollup, now);
        const prevRows = rows.filter((r) => r.tsMs < B);
        expect(await stored(prevStart)).toEqual(aggregate(prevRows));
        expect(await stored(B)).toBeNull(); // still forming — never stored

        // REST replaces the previous bucket's last minute (finished ≤ 15 min ago).
        const lastPrevMinute = B - 60_000;
        await pool.query(
            `UPDATE candles SET high = 999, close = 555, volume = 40
             WHERE pair_id = $1 AND timeframe = '1m' AND ts = to_timestamp($2 / 1000.0)`,
            [fx.pairId, lastPrevMinute],
        );
        await rollupForPair(fx.pairId, rollup, now);

        const fixed = prevRows.map((r) => (r.tsMs === lastPrevMinute ? { ...r, high: 999, close: 555, volume: 40 } : r));
        expect(await stored(prevStart)).toEqual(aggregate(fixed));
    });

    it("…even when a newer row exists (the in-progress bucket the old boot rollup wrote) — no frozen bucket", async () => {
        const rows = minuteRows(prevStart, now.getTime() - 60_000);
        await insertCandles(pool, fx.pairId, "1m", rows);
        await rollupForPair(fx.pairId, rollup, now);
        // A stray row for the CURRENT bucket makes it the latest stored one.
        // Starting only from the latest bucket froze the previous bucket here.
        await insertCandles(pool, fx.pairId, tf, [{ tsMs: B, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);

        const lastPrevMinute = B - 60_000;
        await pool.query(
            `UPDATE candles SET low = 1.5, close = 77, volume = 12
             WHERE pair_id = $1 AND timeframe = '1m' AND ts = to_timestamp($2 / 1000.0)`,
            [fx.pairId, lastPrevMinute],
        );
        await rollupForPair(fx.pairId, rollup, now);

        const fixed = rows
            .filter((r) => r.tsMs < B)
            .map((r) => (r.tsMs === lastPrevMinute ? { ...r, low: 1.5, close: 77, volume: 12 } : r));
        expect(await stored(prevStart)).toEqual(aggregate(fixed));
    });

    it("leaves buckets older than the lookback (and older than the latest bucket) alone", async () => {
        // The bucket just before the one holding now − 15 min.
        const lookbackStart = Math.floor((now.getTime() - ROLLUP_LOOKBACK_MS) / bucketMs) * bucketMs;
        const older = lookbackStart - bucketMs;
        await insertCandles(pool, fx.pairId, "1m", minuteRows(older, now.getTime() - 60_000));
        await rollupForPair(fx.pairId, rollup, now);
        const before = await stored(older);

        await pool.query(
            `UPDATE candles SET high = 999 WHERE pair_id = $1 AND timeframe = '1m' AND ts = to_timestamp($2 / 1000.0)`,
            [fx.pairId, older],
        );
        await rollupForPair(fx.pairId, rollup, now);
        expect(await stored(older)).toEqual(before);
    });
});
