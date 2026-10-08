/**
 * candleBootRollups.test.ts — the boot backfill's 4h (from 1h) and 1w (from
 * 1d) rollups touch only whole, finished buckets with complete source data.
 * Real test DB.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pool } from "../../db/pool";
import { __bootRollupsForTest } from "../candleBackfill";
import { createCandleFixturePair, insertCandles, aggregate, type Row } from "../../testing/candleFixtures";

const H = 3_600_000;
const D = 86_400_000;
const { rollup4hFromHourly, rollup1wFromDaily } = __bootRollupsForTest;

function rows(fromMs: number, toMs: number, stepMs: number): Row[] {
    const out: Row[] = [];
    for (let t = fromMs, k = 0; t < toMs; t += stepMs, k++) {
        const o = 200 + (k % 11);
        out.push({ tsMs: t, open: o, high: o + 5, low: o - 4, close: o + 2, volume: 3 });
    }
    return out;
}

describe.each([
    {
        tf: "4h", srcTf: "1h", step: H, bucket: 4 * H, lookback: 7 * D,
        // Wed 2026-10-07 13:37 UTC — unaligned to the 4h grid and to now − 7d's bucket.
        now: Date.UTC(2026, 9, 7, 13, 37), floor: (t: number) => Math.floor(t / (4 * H)) * 4 * H,
        run: rollup4hFromHourly,
    },
    {
        tf: "1w", srcTf: "1d", step: D, bucket: 7 * D, lookback: 90 * D,
        // Thu 2026-10-08 13:37 UTC — mid-week.
        now: Date.UTC(2026, 9, 8, 13, 37),
        // ISO weeks: Monday 00:00 UTC (the epoch was a Thursday → +3d offset).
        floor: (t: number) => Math.floor((t + 3 * D) / (7 * D)) * 7 * D - 3 * D,
        run: rollup1wFromDaily,
    },
])("boot $tf rollup from $srcTf", ({ tf, srcTf, step, bucket, lookback, now, floor, run }) => {
    let fx: Awaited<ReturnType<typeof createCandleFixturePair>>;
    const firstBucket = floor(now - lookback);
    const currentBucket = floor(now);

    beforeEach(async () => {
        fx = await createCandleFixturePair(pool, "BR");
    });
    afterEach(async () => {
        await fx.cleanup();
    });

    async function stored(): Promise<Map<number, Record<string, number>>> {
        const { rows: r } = await pool.query<{ t: string; open: string; high: string; low: string; close: string; volume: string }>(
            `SELECT (extract(epoch FROM ts) * 1000)::bigint::text t, open::text, high::text, low::text, close::text, volume::text
             FROM candles WHERE pair_id = $1 AND timeframe = $2 ORDER BY ts`,
            [fx.pairId, tf],
        );
        return new Map(r.map((x) => [Number(x.t), { open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume }]));
    }

    it("rolls every whole finished bucket in the window — the first one in full, the current one never", async () => {
        const src = rows(firstBucket - 2 * bucket, floor(now / step * step) + step, step);
        await insertCandles(pool, fx.pairId, srcTf, src);
        // A correct row for the first bucket already exists; an unaligned
        // window start used to overwrite it with a partial aggregate.
        const firstRows = src.filter((r) => r.tsMs >= firstBucket && r.tsMs < firstBucket + bucket);
        await insertCandles(pool, fx.pairId, tf, [{ tsMs: firstBucket, ...aggregate(firstRows) }]);

        await run(fx.pairId, now);
        const s = await stored();

        expect(s.get(firstBucket)).toEqual(aggregate(firstRows));
        expect(s.has(currentBucket)).toBe(false);
        expect(s.has(firstBucket - bucket)).toBe(false); // before the window
        for (let b = firstBucket; b < currentBucket; b += bucket) {
            expect(s.get(b)).toEqual(aggregate(src.filter((r) => r.tsMs >= b && r.tsMs < b + bucket)));
        }
        expect([...s.keys()].every((k) => floor(k) === k)).toBe(true); // all on the UTC grid
    });

    it("skips a bucket with a missing source row instead of overwriting it with a partial one", async () => {
        const gapBucket = currentBucket - bucket;
        const src = rows(firstBucket, currentBucket, step).filter((r) => r.tsMs !== gapBucket + step);
        await insertCandles(pool, fx.pairId, srcTf, src);
        const good = { tsMs: gapBucket, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 };
        await insertCandles(pool, fx.pairId, tf, [good]);

        await run(fx.pairId, now);
        const { tsMs: _t, ...goodOhlcv } = good;
        expect((await stored()).get(gapBucket)).toEqual(goodOhlcv);
    });
});
