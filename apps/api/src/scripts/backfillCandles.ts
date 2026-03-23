/**
 * Historical candle backfill from Coinbase Advanced Trade REST API.
 *
 * Fetches OHLCV data for all active trading pairs and inserts into the
 * `candles` table. Idempotent — safe to re-run (ON CONFLICT DO NOTHING).
 *
 * Usage:
 *   cd apps/api && pnpm backfill
 *
 * Depths:
 *   1m  → 7 days       5m  → 30 days      15m → 90 days
 *   1h  → 1 year       1d  → 2 years       4h  → rolled up from 1h data
 *
 * Gap-fill: checks what's already in the candles table per (pair, timeframe)
 * and only fetches what's missing — oldest gap down to the depth cap.
 */
import "dotenv/config";
import { pool } from "../db/pool";
import {
    fetchCoinbaseCandles,
    sleep,
    CB_PAIR_MAP,
    TF_TO_GRANULARITY,
    type CoinbaseGranularity,
} from "../marketData/coinbaseRest";

// ── Timeframe plans ──

interface TimeframePlan {
    ourTf: string;
    granularity: CoinbaseGranularity;
    candleSeconds: number;
    lookbackSeconds: number;
}

const SEVEN_DAYS      = 7 * 86400;
const THIRTY_DAYS     = 30 * 86400;
const NINETY_DAYS     = 90 * 86400;
const ONE_YEAR        = 365 * 86400;
const TWO_YEARS       = 2 * 365 * 86400;

const TIMEFRAME_PLANS: TimeframePlan[] = [
    { ourTf: "1d",  ...TF_TO_GRANULARITY["1d"]!,  lookbackSeconds: TWO_YEARS },
    { ourTf: "1h",  ...TF_TO_GRANULARITY["1h"]!,  lookbackSeconds: ONE_YEAR },
    { ourTf: "15m", ...TF_TO_GRANULARITY["15m"]!, lookbackSeconds: NINETY_DAYS },
    { ourTf: "5m",  ...TF_TO_GRANULARITY["5m"]!,  lookbackSeconds: THIRTY_DAYS },
    { ourTf: "1m",  ...TF_TO_GRANULARITY["1m"]!,  lookbackSeconds: SEVEN_DAYS },
];

const MAX_CANDLES_PER_REQUEST = 300;
const RATE_LIMIT_MS = 120; // 10 req/s → 100ms minimum; use 120ms for safety
const MAX_RETRIES = 3;

// ── DB helpers ──

interface PairInfo {
    id: string;
    symbol: string;
}

async function loadPairs(): Promise<PairInfo[]> {
    const { rows } = await pool.query<PairInfo>(
        `SELECT id, symbol FROM trading_pairs WHERE is_active = true ORDER BY symbol`,
    );
    return rows.filter((p) => CB_PAIR_MAP[p.symbol]);
}

async function getOldestCandleTs(pairId: string, timeframe: string): Promise<number> {
    const { rows } = await pool.query<{ ts: string }>(
        `SELECT ts FROM candles WHERE pair_id = $1 AND timeframe = $2 ORDER BY ts ASC LIMIT 1`,
        [pairId, timeframe],
    );
    if (rows.length === 0) return 0;
    return Math.floor(new Date(rows[0].ts).getTime() / 1000);
}

async function getLatestCandleTs(pairId: string, timeframe: string): Promise<number> {
    const { rows } = await pool.query<{ ts: string }>(
        `SELECT ts FROM candles WHERE pair_id = $1 AND timeframe = $2 ORDER BY ts DESC LIMIT 1`,
        [pairId, timeframe],
    );
    if (rows.length === 0) return 0;
    return Math.floor(new Date(rows[0].ts).getTime() / 1000);
}

async function insertCandles(
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

// ── Fetch with retry ──

async function fetchWithRetry(
    productId: string,
    granularity: CoinbaseGranularity,
    start: number,
    end: number,
): Promise<Array<{ time: number; open: string; high: string; low: string; close: string; volume: string }>> {
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await fetchCoinbaseCandles(productId, granularity, start, end);
        } catch (err) {
            lastErr = err as Error;
            if (attempt < MAX_RETRIES) {
                const backoff = attempt * 2000;
                console.log(`  Retry ${attempt}/${MAX_RETRIES} after ${backoff}ms: ${lastErr.message}`);
                await sleep(backoff);
            }
        }
    }
    throw lastErr;
}

// ── Per-pair-timeframe backfill ──

async function backfillPairTimeframe(
    pair: PairInfo,
    plan: TimeframePlan,
): Promise<number> {
    const productId = CB_PAIR_MAP[pair.symbol]!;
    const label = `[${pair.symbol}] ${plan.ourTf}`;
    const nowSec = Math.floor(Date.now() / 1000);
    const depthFloor = nowSec - plan.lookbackSeconds;

    // Gap-fill: find oldest existing candle and only fetch backwards from there
    const oldestExisting = await getOldestCandleTs(pair.id, plan.ourTf);
    const latestExisting = await getLatestCandleTs(pair.id, plan.ourTf);

    // Determine what we need to fetch:
    // 1. "backwards" — from depthFloor up to the oldest existing candle (historical gap)
    // 2. "forwards" — from the latest existing candle up to now (recent gap)
    const ranges: Array<{ start: number; end: number; direction: string }> = [];

    if (oldestExisting === 0) {
        // No candles at all — fetch the entire depth range
        ranges.push({ start: depthFloor, end: nowSec, direction: "full" });
    } else {
        // Backwards: fill from depthFloor to oldest existing
        if (oldestExisting > depthFloor + plan.candleSeconds) {
            ranges.push({ start: depthFloor, end: oldestExisting, direction: "backwards" });
        }
        // Forwards: fill from latest existing to now
        if (latestExisting < nowSec - plan.candleSeconds * 2) {
            ranges.push({ start: latestExisting, end: nowSec, direction: "forwards" });
        }
    }

    if (ranges.length === 0) {
        console.log(`${label}: up to date`);
        return 0;
    }

    let totalInserted = 0;

    for (const range of ranges) {
        const windowCandles = Math.floor((range.end - range.start) / plan.candleSeconds);
        console.log(`${label} [${range.direction}]: ~${windowCandles} candles to fetch (${new Date(range.start * 1000).toISOString().slice(0, 10)} → ${new Date(range.end * 1000).toISOString().slice(0, 10)})`);

        // Page through the range in chunks of MAX_CANDLES_PER_REQUEST candles
        let cursor = range.start;
        let page = 0;

        while (cursor < range.end && !stopping) {
            page++;
            const pageEnd = Math.min(cursor + MAX_CANDLES_PER_REQUEST * plan.candleSeconds, range.end);

            const candles = await fetchWithRetry(productId, plan.granularity, cursor, pageEnd);

            // Filter out the current in-progress candle
            const currentBucket = Math.floor(nowSec / plan.candleSeconds) * plan.candleSeconds;
            const completed = candles.filter((c) => c.time < currentBucket);

            if (completed.length > 0) {
                const inserted = await insertCandles(pair.id, plan.ourTf, completed);
                totalInserted += inserted;

                const newest = completed[completed.length - 1]!;
                console.log(`${label}: page ${page}, fetched ${completed.length}, inserted ${inserted}, latest ${new Date(newest.time * 1000).toISOString()}`);
            }

            // Advance cursor past the page window
            cursor = pageEnd;

            await sleep(RATE_LIMIT_MS);
        }
    }

    if (totalInserted > 0) {
        console.log(`${label}: done — ${totalInserted} candles inserted`);
    }

    return totalInserted;
}

// ── 4h rollup from 1h data ──

async function rollup4hFromHourly(pairId: string, pairSymbol: string): Promise<number> {
    const label = `[${pairSymbol}] 4h (rollup)`;

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
         GROUP BY pair_id, bucket
         HAVING COUNT(*) >= 3
         ON CONFLICT (pair_id, timeframe, ts) DO NOTHING`,
        [pairId],
    );

    const inserted = result.rowCount ?? 0;
    if (inserted > 0) {
        console.log(`${label}: ${inserted} candles rolled up from 1h data`);
    } else {
        console.log(`${label}: up to date`);
    }
    return inserted;
}

// ── Main ──

async function main(): Promise<void> {
    console.log("=== Coinbase Historical Candle Backfill ===\n");

    const pairs = await loadPairs();
    if (pairs.length === 0) {
        console.log("No active pairs with Coinbase mapping found. Run pnpm seed first.");
        process.exitCode = 1;
        return;
    }

    console.log(`Found ${pairs.length} pairs: ${pairs.map((p) => p.symbol).join(", ")}\n`);

    for (const pair of pairs) {
        if (stopping) break;
        console.log(`\n--- ${pair.symbol} ---`);

        // Fetch native timeframes from Coinbase
        for (const plan of TIMEFRAME_PLANS) {
            if (stopping) break;
            try {
                await backfillPairTimeframe(pair, plan);
            } catch (err) {
                console.error(`[${pair.symbol}] ${plan.ourTf}: FAILED — ${(err as Error).message}`);
            }
        }

        // Roll up 4h from 1h data (Coinbase has no native 4h granularity)
        if (!stopping) {
            try {
                await rollup4hFromHourly(pair.id, pair.symbol);
            } catch (err) {
                console.error(`[${pair.symbol}] 4h rollup: FAILED — ${(err as Error).message}`);
            }
        }
    }

    console.log("\n=== Backfill complete ===");
}

// Graceful shutdown
let stopping = false;
process.on("SIGINT", () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("\nInterrupted — finishing current request...");
});

main()
    .catch((err) => {
        console.error("Backfill failed:", err);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
