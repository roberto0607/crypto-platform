/**
 * On-boot historical candle backfill from Coinbase Advanced Trade REST API.
 *
 * Fetches the last 7 days of OHLC data for all active trading pairs and upserts
 * into the `candles` table. Runs once on startup to fill gaps from server downtime.
 *
 * Uses ON CONFLICT DO UPDATE — overwrites stale candle data with fresh exchange data.
 * The 4h timeframe is rolled up from 1h data since Coinbase has no native 4h.
 * The 1w timeframe is rolled up from 1d data the same way — no exchange has a
 * native weekly candle either.
 */
import { pool } from "../db/pool.js";
import {
    fetchCoinbaseCandles,
    sleep,
    TF_TO_GRANULARITY,
    type CoinbaseGranularity,
} from "../marketData/coinbaseRest.js";
import { loadActiveSymbols } from "./symbolRegistry.js";
import { logger as rootLogger } from "../observability/logContext.js";

const logger = rootLogger.child({ module: "candleBackfill" });

interface TimeframePlan {
    ourTf: string;
    granularity: CoinbaseGranularity;
    candleSeconds: number;
    lookbackSeconds: number;
}

const SEVEN_DAYS = 7 * 86400;
const NINETY_DAYS = 90 * 86400;

function buildTimeframePlans(): TimeframePlan[] {
    return [
        { ourTf: "1d",  ...TF_TO_GRANULARITY["1d"]!,  lookbackSeconds: SEVEN_DAYS },
        { ourTf: "1h",  ...TF_TO_GRANULARITY["1h"]!,  lookbackSeconds: SEVEN_DAYS },
        { ourTf: "15m", ...TF_TO_GRANULARITY["15m"]!, lookbackSeconds: SEVEN_DAYS },
        { ourTf: "5m",  ...TF_TO_GRANULARITY["5m"]!,  lookbackSeconds: SEVEN_DAYS },
        { ourTf: "1m",  ...TF_TO_GRANULARITY["1m"]!,  lookbackSeconds: SEVEN_DAYS },
    ];
}

const MAX_CANDLES_PER_REQUEST = 300;
const RATE_LIMIT_MS = 120;
const MAX_RETRIES = 3;

export interface BackfillResult {
    totalInserted: number;
    totalErrors: number;
    totalSkipped: number;
    durationMs: number;
}

/**
 * True when the most recent candle for this (pair, timeframe) is recent
 * enough that a full 7-day re-walk would be wasted work — e.g. on every
 * boot once the curated universe is ~75 pairs. "Recent" allows a few candle
 * periods of slack, since backfill runs once at boot and the live feed's
 * candle aggregator may not have flushed the very latest bar yet.
 */
async function hasRecentCandle(pairId: string, timeframe: string, candleSeconds: number): Promise<boolean> {
    const { rows } = await pool.query<{ ts: string }>(
        `SELECT ts FROM candles WHERE pair_id = $1 AND timeframe = $2 ORDER BY ts DESC LIMIT 1`,
        [pairId, timeframe],
    );
    if (rows.length === 0) return false;
    const ageSeconds = (Date.now() - new Date(rows[0]!.ts).getTime()) / 1000;
    return ageSeconds < candleSeconds * 3;
}

export async function insertCandleBatch(
    pairId: string,
    timeframe: string,
    candles: Array<{ time: number; open: string; high: string; low: string; close: string; volume: string }>,
): Promise<number> {
    if (candles.length === 0) return 0;

    const values: string[] = [];
    const params: (string | number)[] = [];
    let idx = 1;

    for (const c of candles) {
        const ts = new Date(c.time * 1000).toISOString();
        values.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7})`);
        params.push(pairId, timeframe, ts, c.open, c.high, c.low, c.close, c.volume);
        idx += 8;
    }

    const sql = `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
                 VALUES ${values.join(", ")}
                 ON CONFLICT (pair_id, timeframe, ts) DO UPDATE SET
                     open = EXCLUDED.open,
                     high = EXCLUDED.high,
                     low = EXCLUDED.low,
                     close = EXCLUDED.close,
                     volume = EXCLUDED.volume`;

    const result = await pool.query(sql, params);
    return result.rowCount ?? 0;
}

async function fetchWithRetry(
    productId: string,
    granularity: CoinbaseGranularity,
    start: number,
    end: number,
): ReturnType<typeof fetchCoinbaseCandles> {
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await fetchCoinbaseCandles(productId, granularity, start, end);
        } catch (err) {
            lastErr = err as Error;
            if (attempt < MAX_RETRIES) {
                const backoff = attempt * 2000;
                logger.warn({ attempt, backoff, err: lastErr.message }, "backfill_retry");
                await sleep(backoff);
            }
        }
    }
    throw lastErr;
}

/**
 * Backfill a single (pair, timeframe) combination for the last 7 days.
 */
async function backfillPairTimeframe(
    pairId: string,
    pairSymbol: string,
    productId: string,
    plan: TimeframePlan,
): Promise<number> {
    const nowSec = Math.floor(Date.now() / 1000);
    const start = nowSec - plan.lookbackSeconds;
    const currentBucket = Math.floor(nowSec / plan.candleSeconds) * plan.candleSeconds;

    let totalInserted = 0;
    let cursor = start;
    let page = 0;

    while (cursor < nowSec) {
        page++;
        const pageEnd = Math.min(cursor + MAX_CANDLES_PER_REQUEST * plan.candleSeconds, nowSec);

        const candles = await fetchWithRetry(productId, plan.granularity, cursor, pageEnd);
        const completed = candles.filter((c) => c.time < currentBucket);

        if (completed.length > 0) {
            const inserted = await insertCandleBatch(pairId, plan.ourTf, completed);
            totalInserted += inserted;

            logger.info(
                { pair: pairSymbol, tf: plan.ourTf, page, fetched: completed.length, inserted },
                "backfill_page_done",
            );
        }

        cursor = pageEnd;
        await sleep(RATE_LIMIT_MS);
    }

    if (totalInserted > 0) {
        logger.info(
            { pair: pairSymbol, tf: plan.ourTf, totalInserted, pages: page },
            "backfill_tf_complete",
        );
    }

    return totalInserted;
}

/**
 * Roll up 4h candles from 1h data for the last 7 days.
 */
async function rollup4hFromHourly(pairId: string): Promise<number> {
    const sevenDaysAgo = new Date(Date.now() - SEVEN_DAYS * 1000).toISOString();

    const result = await pool.query(
        `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
         SELECT
             pair_id,
             '4h',
             date_trunc('day', ts) + (FLOOR(EXTRACT(HOUR FROM ts) / 4) * INTERVAL '4 hours') AS bucket,
             (ARRAY_AGG(open ORDER BY ts ASC))[1],
             MAX(high),
             MIN(low),
             (ARRAY_AGG(close ORDER BY ts DESC))[1],
             SUM(volume)
         FROM candles
         WHERE pair_id = $1
           AND timeframe = '1h'
           AND ts >= $2
         GROUP BY pair_id, bucket
         HAVING COUNT(*) >= 3
         ON CONFLICT (pair_id, timeframe, ts) DO UPDATE SET
             open = EXCLUDED.open,
             high = EXCLUDED.high,
             low = EXCLUDED.low,
             close = EXCLUDED.close,
             volume = EXCLUDED.volume`,
        [pairId, sevenDaysAgo],
    );

    return result.rowCount ?? 0;
}

/**
 * Roll up 1w candles from 1d data for the last 90 days. Weekly buckets use
 * Postgres's native date_trunc('week', ts) — ISO-8601, Monday 00:00 UTC —
 * matching weeklyUtils.ts's week convention and candleRollupJob.ts's
 * Monday-aligned 1w bucketing. A wider lookback than the 4h rollup's 7 days
 * since weekly buckets are much coarser and 1d history typically runs deeper.
 */
async function rollup1wFromDaily(pairId: string): Promise<number> {
    const ninetyDaysAgo = new Date(Date.now() - NINETY_DAYS * 1000).toISOString();

    const result = await pool.query(
        `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
         SELECT
             pair_id,
             '1w',
             date_trunc('week', ts) AS bucket,
             (ARRAY_AGG(open ORDER BY ts ASC))[1],
             MAX(high),
             MIN(low),
             (ARRAY_AGG(close ORDER BY ts DESC))[1],
             SUM(volume)
         FROM candles
         WHERE pair_id = $1
           AND timeframe = '1d'
           AND ts >= $2
         GROUP BY pair_id, bucket
         HAVING COUNT(*) >= 5
         ON CONFLICT (pair_id, timeframe, ts) DO UPDATE SET
             open = EXCLUDED.open,
             high = EXCLUDED.high,
             low = EXCLUDED.low,
             close = EXCLUDED.close,
             volume = EXCLUDED.volume`,
        [pairId, ninetyDaysAgo],
    );

    return result.rowCount ?? 0;
}

/**
 * Run the candle backfill for all active pairs and timeframes.
 * Fetches the last 7 days from Coinbase, then rolls up 4h from 1h and 1w from 1d.
 */
export async function runBackfill(): Promise<BackfillResult> {
    const start = Date.now();
    let totalInserted = 0;
    let totalErrors = 0;
    let totalSkipped = 0;

    const mappedPairs = await loadActiveSymbols("coinbase");

    if (mappedPairs.length === 0) {
        logger.warn("No active pairs with Coinbase REST mapping found");
        return { totalInserted: 0, totalErrors: 0, totalSkipped: 0, durationMs: Date.now() - start };
    }

    const plans = buildTimeframePlans();

    logger.info({ pairs: mappedPairs.map((p) => p.ourSymbol) }, "candle_backfill_starting");

    for (const pair of mappedPairs) {
        const productId = pair.restSymbol;

        for (const plan of plans) {
            try {
                if (await hasRecentCandle(pair.pairId, plan.ourTf, plan.candleSeconds)) {
                    totalSkipped++;
                    continue;
                }
                const inserted = await backfillPairTimeframe(
                    pair.pairId, pair.ourSymbol, productId, plan,
                );
                totalInserted += inserted;
            } catch (err) {
                totalErrors++;
                logger.warn(
                    { pair: pair.ourSymbol, tf: plan.ourTf, err: (err as Error).message },
                    "backfill_tf_failed",
                );
            }
        }

        // Roll up 4h from the freshly-backfilled 1h data — skip if the 4h
        // series is already current (same recency check as the fetch loop).
        try {
            if (await hasRecentCandle(pair.pairId, "4h", 4 * 3600)) {
                totalSkipped++;
            } else {
                const rolled = await rollup4hFromHourly(pair.pairId);
                totalInserted += rolled;
            }
        } catch (err) {
            totalErrors++;
            logger.warn(
                { pair: pair.ourSymbol, tf: "4h", err: (err as Error).message },
                "backfill_4h_rollup_failed",
            );
        }

        // Roll up 1w from the 1d series — skip if the 1w series is already
        // current (same recency check pattern as the 4h rollup above).
        try {
            if (await hasRecentCandle(pair.pairId, "1w", 7 * 24 * 3600)) {
                totalSkipped++;
            } else {
                const rolled = await rollup1wFromDaily(pair.pairId);
                totalInserted += rolled;
            }
        } catch (err) {
            totalErrors++;
            logger.warn(
                { pair: pair.ourSymbol, tf: "1w", err: (err as Error).message },
                "backfill_1w_rollup_failed",
            );
        }
    }

    const result = { totalInserted, totalErrors, totalSkipped, durationMs: Date.now() - start };
    logger.info(result, "candle_backfill_complete");
    return result;
}
