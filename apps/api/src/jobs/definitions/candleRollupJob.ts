import type { JobDefinition } from "../jobTypes.js";
import { pool } from "../../db/pool.js";
import { logger } from "../../observability/logContext.js";

/**
 * Rollup 1m candles into higher timeframes.
 *
 * Strategy: For each (pair, target_timeframe), find the latest candle
 * in that timeframe, then aggregate 1m candles since that point.
 */

interface RollupConfig {
    timeframe: string;
    minutes: number;
}

const ROLLUPS: RollupConfig[] = [
    { timeframe: "5m", minutes: 5 },
    { timeframe: "15m", minutes: 15 },
    { timeframe: "1h", minutes: 60 },
    { timeframe: "4h", minutes: 240 },
    { timeframe: "1d", minutes: 1440 },
    // Sourced from raw 1m rows same as every other entry here (not chained
    // from 1d) — the boot backfill and full-history script derive 1w from 1d
    // instead (see candleBackfill.ts / scripts/backfillCandles.ts), but this
    // job's job is just to keep the currently-forming bucket accumulating in
    // near-real-time regardless of target timeframe.
    { timeframe: "1w", minutes: 10080 },
];

// Unix epoch (1970-01-01T00:00:00Z) was a Thursday. Every other interval
// above divides evenly into a day (or is exactly one day), so naive epoch-ms
// flooring always lands on a valid boundary no matter what weekday the epoch
// falls on. A 7-day (weekly) interval doesn't have that property — naive
// flooring aligns buckets to Thursdays, not the ISO-8601 Monday-start week
// that rollup1wFromDaily (candleBackfill.ts) and weeklyUtils.ts already use
// via `date_trunc('week', ts)`. Shift by the 3-day gap between the epoch and
// the preceding Monday so this job's weekly buckets land on the same Monday
// 00:00 UTC boundaries as those, instead of silently drifting to Thursdays.
const WEEK_MINUTES = 10080;
const MONDAY_EPOCH_OFFSET_MS = 3 * 24 * 60 * 60_000;

function bucketOffsetMs(intervalMinutes: number): number {
    return intervalMinutes === WEEK_MINUTES ? MONDAY_EPOCH_OFFSET_MS : 0;
}

function floorToInterval(ts: Date, intervalMinutes: number): Date {
    const ms = ts.getTime();
    const intervalMs = intervalMinutes * 60_000;
    const offset = bucketOffsetMs(intervalMinutes);
    return new Date(Math.floor((ms + offset) / intervalMs) * intervalMs - offset);
}

async function rollupForPair(pairId: string, rollup: RollupConfig): Promise<void> {
    // Find the latest candle for this timeframe
    const { rows: latest } = await pool.query<{ ts: string }>(
        `SELECT ts FROM candles
         WHERE pair_id = $1 AND timeframe = $2
         ORDER BY ts DESC LIMIT 1`,
        [pairId, rollup.timeframe],
    );

    // Start from latest existing candle, or from the oldest 1m candle
    let since: Date;
    if (latest.length > 0) {
        since = new Date(latest[0].ts);
    } else {
        const { rows: oldest } = await pool.query<{ ts: string }>(
            `SELECT ts FROM candles
             WHERE pair_id = $1 AND timeframe = '1m'
             ORDER BY ts ASC LIMIT 1`,
            [pairId],
        );
        if (oldest.length === 0) return; // No 1m data yet
        since = floorToInterval(new Date(oldest[0].ts), rollup.minutes);
    }

    // Aggregate 1m candles into the target timeframe
    const intervalSeconds = rollup.minutes * 60;
    const offsetSeconds = bucketOffsetMs(rollup.minutes) / 1000;

    const { rows } = await pool.query<{
        bucket: string;
        open: string;
        high: string;
        low: string;
        close: string;
        volume: string;
        buy_volume: string;
        sell_volume: string;
    }>(
        `WITH bucketed AS (
            SELECT
                to_timestamp(
                    floor((extract(epoch FROM ts) + $4) / $3) * $3 - $4
                ) AS bucket,
                ts,
                open, high, low, close, volume, buy_volume, sell_volume
            FROM candles
            WHERE pair_id = $1
              AND timeframe = '1m'
              AND ts >= $2
        )
        SELECT
            bucket::text,
            (array_agg(open ORDER BY ts ASC))[1] AS open,
            MAX(high)::text AS high,
            MIN(low)::text AS low,
            (array_agg(close ORDER BY ts DESC))[1] AS close,
            SUM(volume)::text AS volume,
            SUM(buy_volume)::text AS buy_volume,
            SUM(sell_volume)::text AS sell_volume
        FROM bucketed
        GROUP BY bucket
        HAVING COUNT(*) > 0
        ORDER BY bucket`,
        [pairId, since.toISOString(), intervalSeconds, offsetSeconds],
    );

    // Skip the last bucket (may still be in progress)
    const now = new Date();
    const currentBucket = floorToInterval(now, rollup.minutes);

    for (const row of rows) {
        const bucketTime = new Date(row.bucket);
        if (bucketTime.getTime() >= currentBucket.getTime()) continue; // Still open

        await pool.query(
            `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume, buy_volume, sell_volume)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (pair_id, timeframe, ts) DO UPDATE SET
                 open = EXCLUDED.open,
                 high = EXCLUDED.high,
                 low = EXCLUDED.low,
                 close = EXCLUDED.close,
                 volume = EXCLUDED.volume,
                 buy_volume = EXCLUDED.buy_volume,
                 sell_volume = EXCLUDED.sell_volume`,
            [pairId, rollup.timeframe, row.bucket, row.open, row.high, row.low, row.close, row.volume, row.buy_volume, row.sell_volume],
        );
    }
}

export const candleRollupJob: JobDefinition = {
    name: "candle-rollup",
    intervalSeconds: 60,
    maxRunSeconds: 120, // 120s = 2× the default 60s run timeout; multi-timeframe candle batching can stretch under load
    async run(_ctx) {
        // Get all active pairs
        const { rows: pairs } = await pool.query<{ id: string }>(
            `SELECT id FROM trading_pairs WHERE is_active = true`,
        );

        for (const pair of pairs) {
            for (const rollup of ROLLUPS) {
                try {
                    await rollupForPair(pair.id, rollup);
                } catch (err) {
                    logger.error(
                        { err, pairId: pair.id, timeframe: rollup.timeframe },
                        "candle_rollup_failed",
                    );
                }
            }
        }
    },
};
