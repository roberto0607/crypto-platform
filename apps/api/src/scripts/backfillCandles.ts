/**
 * Historical candle backfill from Kraken REST API.
 *
 * Fetches OHLCV data for all active trading pairs and inserts into the
 * `candles` table. Idempotent — safe to re-run (ON CONFLICT DO NOTHING).
 *
 * Usage:
 *   cd apps/api && pnpm backfill
 *
 * The script fetches each timeframe directly from Kraken (no rollup dependency).
 * Higher timeframes fetch full history; lower timeframes are time-capped.
 */
import "dotenv/config";
import { pool } from "../db/pool";
import { fetchOHLC, sleep, REST_PAIR_MAP } from "../market/krakenRest";

interface TimeframePlan {
    ourTf: string;          // e.g. "1d"
    krakenInterval: number; // e.g. 1440
    sinceCap: number;       // 0 = full history, or Unix timestamp lower bound
}

const TWO_YEARS_AGO = Math.floor(Date.now() / 1000) - 2 * 365 * 86400;
const THIRTY_DAYS_AGO = Math.floor(Date.now() / 1000) - 30 * 86400;
const SEVEN_DAYS_AGO = Math.floor(Date.now() / 1000) - 7 * 86400;

const TIMEFRAME_PLANS: TimeframePlan[] = [
    { ourTf: "1d",  krakenInterval: 1440, sinceCap: 0 },
    { ourTf: "4h",  krakenInterval: 240,  sinceCap: 0 },
    { ourTf: "1h",  krakenInterval: 60,   sinceCap: 0 },
    { ourTf: "15m", krakenInterval: 15,   sinceCap: TWO_YEARS_AGO },
    { ourTf: "5m",  krakenInterval: 5,    sinceCap: THIRTY_DAYS_AGO },
    { ourTf: "1m",  krakenInterval: 1,    sinceCap: SEVEN_DAYS_AGO },
];

const RATE_LIMIT_MS = 2000; // 2s between requests (Kraken public rate limit is strict)
const MAX_RETRIES = 3;

interface PairInfo {
    id: string;
    symbol: string;
}

async function loadPairs(): Promise<PairInfo[]> {
    const { rows } = await pool.query<PairInfo>(
        `SELECT id, symbol FROM trading_pairs WHERE is_active = true ORDER BY symbol`,
    );
    return rows.filter((p) => REST_PAIR_MAP[p.symbol]);
}

async function getLatestCandle(pairId: string, timeframe: string): Promise<number> {
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

    // Batch insert with multi-row VALUES
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
                console.log(`  Retry ${attempt}/${MAX_RETRIES} after ${backoff}ms: ${lastErr.message}`);
                await sleep(backoff);
            }
        }
    }
    throw lastErr;
}

async function backfillPairTimeframe(
    pair: PairInfo,
    plan: TimeframePlan,
): Promise<void> {
    const krakenPair = REST_PAIR_MAP[pair.symbol]!;
    const label = `[${pair.symbol}] ${plan.ourTf}`;

    // Resume from latest existing candle or start from sinceCap
    const latestExisting = await getLatestCandle(pair.id, plan.ourTf);
    let since = Math.max(latestExisting, plan.sinceCap);

    console.log(`${label}: starting from ${since === 0 ? "epoch" : new Date(since * 1000).toISOString()}`);

    let totalInserted = 0;
    let page = 0;

    while (true) {
        page++;
        const result = await fetchWithRetry(krakenPair, plan.krakenInterval, since);

        // Drop the last entry (current in-progress candle)
        const completed = result.candles.slice(0, -1);

        if (completed.length === 0) {
            console.log(`${label}: done — ${totalInserted} candles inserted (${page} pages)`);
            break;
        }

        const inserted = await insertCandles(pair.id, plan.ourTf, completed);
        totalInserted += inserted;

        const newest = completed[completed.length - 1]!;
        console.log(`${label}: page ${page}, fetched ${completed.length}, inserted ${inserted}, latest ${new Date(newest.time * 1000).toISOString()}`);

        // If we got fewer than 719 entries (720 minus the in-progress one), we've caught up
        if (completed.length < 719) {
            console.log(`${label}: done — ${totalInserted} candles inserted (${page} pages)`);
            break;
        }

        // Advance cursor
        since = result.last;

        // Rate limit
        await sleep(RATE_LIMIT_MS);
    }
}

async function main(): Promise<void> {
    console.log("=== Kraken Historical Candle Backfill ===\n");

    const pairs = await loadPairs();
    if (pairs.length === 0) {
        console.log("No active pairs with Kraken mapping found. Run pnpm seed first.");
        process.exitCode = 1;
        return;
    }

    console.log(`Found ${pairs.length} pairs: ${pairs.map((p) => p.symbol).join(", ")}\n`);

    for (const pair of pairs) {
        console.log(`\n--- ${pair.symbol} ---`);
        for (const plan of TIMEFRAME_PLANS) {
            try {
                await backfillPairTimeframe(pair, plan);
                await sleep(RATE_LIMIT_MS); // pause between timeframes
            } catch (err) {
                console.error(`[${pair.symbol}] ${plan.ourTf}: FAILED — ${(err as Error).message}`);
                // Continue with next timeframe/pair
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
