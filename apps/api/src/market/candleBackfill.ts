/**
 * On-boot historical candle backfill from Kraken REST API.
 *
 * Fetches complete OHLC history for all active trading pairs and upserts into
 * the `candles` table. Runs once on startup to fill gaps from server downtime.
 *
 * Paginates through all available history per timeframe (same as the standalone
 * CLI script). Higher timeframes fetch full history; lower timeframes are
 * time-capped to what Kraken retains (7d for 1m, 30d for 5m, etc.).
 *
 * Uses ON CONFLICT DO NOTHING — never overwrites live candle data.
 */
import { pool } from "../db/pool.js";
import { fetchOHLC, sleep, REST_PAIR_MAP } from "./krakenRest.js";
import { listActivePairs } from "../trading/pairRepo.js";
import { logger as rootLogger } from "../observability/logContext.js";

const logger = rootLogger.child({ module: "candleBackfill" });

interface TimeframePlan {
    ourTf: string;
    krakenInterval: number;
    sinceCap: number; // 0 = full history, or Unix timestamp lower bound
}

function buildTimeframePlans(): TimeframePlan[] {
    const TWO_YEARS_AGO = Math.floor(Date.now() / 1000) - 2 * 365 * 86400;
    const THIRTY_DAYS_AGO = Math.floor(Date.now() / 1000) - 30 * 86400;
    const SEVEN_DAYS_AGO = Math.floor(Date.now() / 1000) - 7 * 86400;

    return [
        { ourTf: "1d",  krakenInterval: 1440, sinceCap: 0 },
        { ourTf: "4h",  krakenInterval: 240,  sinceCap: 0 },
        { ourTf: "1h",  krakenInterval: 60,   sinceCap: 0 },
        { ourTf: "15m", krakenInterval: 15,   sinceCap: TWO_YEARS_AGO },
        { ourTf: "5m",  krakenInterval: 5,    sinceCap: THIRTY_DAYS_AGO },
        { ourTf: "1m",  krakenInterval: 1,    sinceCap: SEVEN_DAYS_AGO },
    ];
}

const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;

export interface BackfillResult {
    totalInserted: number;
    totalErrors: number;
    durationMs: number;
}

async function getLatestCandleTs(pairId: string, timeframe: string): Promise<number> {
    const { rows } = await pool.query<{ ts: string }>(
        `SELECT ts FROM candles WHERE pair_id = $1 AND timeframe = $2 ORDER BY ts DESC LIMIT 1`,
        [pairId, timeframe],
    );
    if (rows.length === 0) return 0;
    return Math.floor(new Date(rows[0]!.ts).getTime() / 1000);
}

async function insertCandleBatch(
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
                 ON CONFLICT (pair_id, timeframe, ts) DO NOTHING`;

    const result = await pool.query(sql, params);
    return result.rowCount ?? 0;
}

async function fetchWithRetry(
    krakenPair: string,
    interval: number,
    since: number,
): ReturnType<typeof fetchOHLC> {
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await fetchOHLC(krakenPair, interval, since);
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
 * Backfill a single (pair, timeframe) combination.
 * Paginates through all available Kraken history until caught up.
 */
async function backfillPairTimeframe(
    pairId: string,
    pairSymbol: string,
    krakenPair: string,
    plan: TimeframePlan,
): Promise<number> {
    // Resume from latest existing candle or start from sinceCap
    const latestExisting = await getLatestCandleTs(pairId, plan.ourTf);
    let since = Math.max(latestExisting, plan.sinceCap);

    let totalInserted = 0;
    let page = 0;

    while (true) {
        page++;
        const result = await fetchWithRetry(krakenPair, plan.krakenInterval, since);

        // Drop the last entry (current in-progress candle)
        const completed = result.candles.slice(0, -1);

        if (completed.length === 0) break;

        const inserted = await insertCandleBatch(pairId, plan.ourTf, completed);
        totalInserted += inserted;

        logger.info(
            { pair: pairSymbol, tf: plan.ourTf, page, fetched: completed.length, inserted },
            "backfill_page_done",
        );

        // If we got fewer than 719 entries (720 minus the in-progress one), we've caught up
        if (completed.length < 719) break;

        // Advance cursor to next page
        since = result.last;

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
 * Run the candle backfill for all active pairs and timeframes.
 * Paginates through complete Kraken history for each (pair, timeframe).
 * Returns summary stats.
 */
export async function runBackfill(): Promise<BackfillResult> {
    const start = Date.now();
    let totalInserted = 0;
    let totalErrors = 0;

    const pairs = await listActivePairs();
    const mappedPairs = pairs.filter((p) => REST_PAIR_MAP[p.symbol]);

    if (mappedPairs.length === 0) {
        logger.warn("No active pairs with Kraken REST mapping found");
        return { totalInserted: 0, totalErrors: 0, durationMs: Date.now() - start };
    }

    const plans = buildTimeframePlans();

    logger.info({ pairs: mappedPairs.map((p) => p.symbol) }, "candle_backfill_starting");

    for (const pair of mappedPairs) {
        const krakenPair = REST_PAIR_MAP[pair.symbol]!;

        for (const plan of plans) {
            try {
                const inserted = await backfillPairTimeframe(
                    pair.id, pair.symbol, krakenPair, plan,
                );
                totalInserted += inserted;
                await sleep(RATE_LIMIT_MS);
            } catch (err) {
                totalErrors++;
                logger.warn(
                    { pair: pair.symbol, tf: plan.ourTf, err: (err as Error).message },
                    "backfill_tf_failed",
                );
            }
        }
    }

    return { totalInserted, totalErrors, durationMs: Date.now() - start };
}
