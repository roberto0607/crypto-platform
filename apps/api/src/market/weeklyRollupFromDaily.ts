import type { Pool, PoolClient } from "pg";

/**
 * Full-history 1w rollup from the stored 1d rows of one pair (Phase 4 of
 * scripts/backfillCandles.ts). Inserts new weeks only (ON CONFLICT DO NOTHING).
 *
 * Buckets are Monday 00:00 UTC, like candleBackfill.ts / historyBackfill.ts /
 * the rollup job. `date_trunc` on a timestamptz truncates in the SESSION time
 * zone, so the UTC conversion is explicit: a bare date_trunc('week', ts) under
 * a New York session would write weeks starting Monday 05:00 UTC.
 */
export async function rollupAllWeeksFromDaily(db: Pool | PoolClient, pairId: string): Promise<number> {
    const result = await db.query(
        `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
         SELECT
             pair_id,
             '1w',
             date_trunc('week', ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
             (ARRAY_AGG(open ORDER BY ts ASC))[1],
             MAX(high),
             MIN(low),
             (ARRAY_AGG(close ORDER BY ts DESC))[1],
             SUM(volume)
         FROM candles
         WHERE pair_id = $1
           AND timeframe = '1d'
         GROUP BY pair_id, bucket
         HAVING COUNT(*) >= 5
         ON CONFLICT (pair_id, timeframe, ts) DO NOTHING`,
        [pairId],
    );
    return result.rowCount ?? 0;
}
