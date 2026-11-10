/**
 * The backfill script's full-history 1w rollup must bucket on Monday 00:00
 * UTC whatever the session time zone is (date_trunc on a timestamptz
 * truncates in the session zone). Real test DB.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { pool } from "../../db/pool";
import { ensureMigrations } from "../../testing/resetDb";
import { createCandleFixturePair, insertCandles, type Row } from "../../testing/candleFixtures";
import { rollupAllWeeksFromDaily } from "../weeklyRollupFromDaily";

const DAY_MS = 86_400_000;
const MONDAY = Date.UTC(2026, 0, 5); // Monday 2026-01-05 00:00 UTC

describe("rollupAllWeeksFromDaily", () => {
    let fx: Awaited<ReturnType<typeof createCandleFixturePair>>;

    beforeAll(async () => {
        await ensureMigrations();
    });
    beforeEach(async () => {
        fx = await createCandleFixturePair(pool, "WK");
    });
    afterEach(async () => {
        await fx.cleanup();
    });

    it.each(["UTC", "America/New_York", "Asia/Tokyo"])("buckets on Monday 00:00 UTC under a %s session", async (zone) => {
        // Three full weeks of daily bars; day k opens at 100 + k.
        const days: Row[] = Array.from({ length: 21 }, (_, k) => ({
            tsMs: MONDAY + k * DAY_MS, open: 100 + k, high: 200 + k, low: 50 + k, close: 101 + k, volume: 1,
        }));
        await insertCandles(pool, fx.pairId, "1d", days);

        const client = await pool.connect();
        try {
            await client.query(`SET TIME ZONE '${zone}'`);
            expect(await rollupAllWeeksFromDaily(client, fx.pairId)).toBe(3);
        } finally {
            await client.query("RESET TIME ZONE");
            client.release();
        }

        const { rows } = await pool.query<{ ts: Date; open: string; high: string; low: string; close: string; volume: string }>(
            `SELECT ts, open, high, low, close, volume FROM candles
             WHERE pair_id = $1 AND timeframe = '1w' ORDER BY ts`,
            [fx.pairId],
        );
        expect(rows.map((r) => r.ts.getTime())).toEqual([MONDAY, MONDAY + 7 * DAY_MS, MONDAY + 14 * DAY_MS]);
        rows.forEach((r, w) => {
            expect(Number(r.open)).toBe(100 + 7 * w);
            expect(Number(r.close)).toBe(101 + 7 * w + 6);
            expect(Number(r.high)).toBe(200 + 7 * w + 6);
            expect(Number(r.low)).toBe(50 + 7 * w);
            expect(Number(r.volume)).toBe(7);
        });
    });
});
