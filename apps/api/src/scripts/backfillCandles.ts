/**
 * Historical candle backfill — CryptoCompare (deep history) + Coinbase (recent granular).
 *
 * Strategy:
 *   1d  → CryptoCompare histoday  (allData — full coin lifetime)
 *   1h  → CryptoCompare histohour (full history, paginated)
 *   15m → Coinbase                (90 days)
 *   5m  → Coinbase                (30 days)
 *   1m  → Coinbase                (7 days)
 *   4h  → Rolled up from 1h data  (no native source)
 *
 * Gap-fill: checks what's already in the candles table per (pair, timeframe)
 * and only fetches what's missing.
 *
 * Usage:
 *   cd apps/api && pnpm backfill
 */
import "dotenv/config";
import { pool } from "../db/pool";
import {
    fetchCoinbaseCandles,
    sleep as cbSleep,
    CB_PAIR_MAP,
    TF_TO_GRANULARITY,
    type CoinbaseGranularity,
} from "../marketData/coinbaseRest";
import {
    fetchCCCandles,
    fetchCCAllDaily,
    sleep as ccSleep,
    CC_PAIR_MAP,
} from "../marketData/cryptoCompareRest";

// ── Constants ──

const SEVEN_DAYS  = 7 * 86400;
const THIRTY_DAYS = 30 * 86400;
const NINETY_DAYS = 90 * 86400;

const CB_RATE_LIMIT_MS = 120;   // Coinbase: 10 req/s → 120ms
const CC_RATE_LIMIT_MS = 220;   // CryptoCompare: 5 req/s → 220ms
const MAX_RETRIES = 3;

// ── DB helpers ──

interface PairInfo { id: string; symbol: string }

interface OHLCEntry {
    time: number;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
}

async function loadPairs(): Promise<PairInfo[]> {
    const { rows } = await pool.query<PairInfo>(
        `SELECT id, symbol FROM trading_pairs WHERE is_active = true ORDER BY symbol`,
    );
    // Only pairs that both sources can serve
    return rows.filter((p) => CB_PAIR_MAP[p.symbol] && CC_PAIR_MAP[p.symbol]);
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

async function getCandleCount(pairId: string, timeframe: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM candles WHERE pair_id = $1 AND timeframe = $2`,
        [pairId, timeframe],
    );
    return parseInt(rows[0]!.count, 10);
}

async function insertCandles(
    pairId: string,
    timeframe: string,
    candles: OHLCEntry[],
): Promise<number> {
    if (candles.length === 0) return 0;

    // Batch in chunks of 250 to stay under Postgres param limit (65535 / 8 = ~8191)
    const BATCH = 250;
    let totalInserted = 0;

    for (let i = 0; i < candles.length; i += BATCH) {
        const chunk = candles.slice(i, i + BATCH);
        const values: string[] = [];
        const params: (string | number)[] = [];
        let idx = 1;

        for (const c of chunk) {
            const ts = new Date(c.time * 1000).toISOString();
            values.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7})`);
            params.push(pairId, timeframe, ts, c.open, c.high, c.low, c.close, c.volume);
            idx += 8;
        }

        const sql = `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
                     VALUES ${values.join(", ")}
                     ON CONFLICT (pair_id, timeframe, ts) DO NOTHING`;

        const result = await pool.query(sql, params);
        totalInserted += result.rowCount ?? 0;
    }

    return totalInserted;
}

// ── Retry wrapper ──

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err as Error;
            if (attempt < MAX_RETRIES) {
                const backoff = attempt * 2000;
                console.log(`  Retry ${attempt}/${MAX_RETRIES} (${label}): ${lastErr.message}`);
                await cbSleep(backoff);
            }
        }
    }
    throw lastErr;
}

// ═══════════════════════════════════════════════════════════════
// Phase 1: CryptoCompare — deep 1d and 1h history
// ═══════════════════════════════════════════════════════════════

async function backfillDailyCC(pair: PairInfo): Promise<number> {
    const cc = CC_PAIR_MAP[pair.symbol]!;
    const label = `[${pair.symbol}] 1d (CC)`;

    const oldestExisting = await getOldestCandleTs(pair.id, "1d");
    const existingCount = await getCandleCount(pair.id, "1d");

    // Use allData=true for a single-request full history fetch
    console.log(`${label}: fetching full history via allData=true...`);
    const candles = await withRetry(
        () => fetchCCAllDaily(cc.fsym, cc.tsym),
        label,
    );

    if (candles.length === 0) {
        console.log(`${label}: no data returned`);
        return 0;
    }

    // If we already have data, only insert candles older than oldest existing
    // or newer than latest existing (gap-fill)
    const latestExisting = await getLatestCandleTs(pair.id, "1d");
    let toInsert = candles;

    if (oldestExisting > 0) {
        toInsert = candles.filter(
            (c) => c.time < oldestExisting || c.time > latestExisting,
        );
    }

    const inserted = await insertCandles(pair.id, "1d", toInsert);
    const range = `${new Date(candles[0]!.time * 1000).toISOString().slice(0, 10)} → ${new Date(candles[candles.length - 1]!.time * 1000).toISOString().slice(0, 10)}`;
    console.log(`${label}: ${candles.length} total candles (${range}), ${inserted} new (had ${existingCount})`);

    return inserted;
}

async function backfillHourlyCC(pair: PairInfo): Promise<number> {
    const cc = CC_PAIR_MAP[pair.symbol]!;
    const label = `[${pair.symbol}] 1h (CC)`;
    const nowSec = Math.floor(Date.now() / 1000);
    const candleSeconds = 3600;

    const oldestExisting = await getOldestCandleTs(pair.id, "1h");
    const latestExisting = await getLatestCandleTs(pair.id, "1h");

    // Determine ranges to fetch
    const ranges: Array<{ toTs: number; stopAt: number; direction: string }> = [];

    if (oldestExisting === 0) {
        // No data — page backwards from now to the beginning
        ranges.push({ toTs: nowSec, stopAt: 0, direction: "full" });
    } else {
        // Backwards: fill from oldest existing back to coin origin
        ranges.push({ toTs: oldestExisting, stopAt: 0, direction: "backwards" });
        // Forwards: fill from latest existing to now
        if (latestExisting < nowSec - candleSeconds * 2) {
            ranges.push({ toTs: nowSec, stopAt: latestExisting, direction: "forwards" });
        }
    }

    let totalInserted = 0;

    for (const range of ranges) {
        let toTs = range.toTs;
        let page = 0;
        let emptyPages = 0;

        console.log(`${label} [${range.direction}]: paging from ${new Date(toTs * 1000).toISOString().slice(0, 10)}...`);

        while (!stopping) {
            page++;
            const result = await withRetry(
                () => fetchCCCandles("histohour", cc.fsym, cc.tsym, 2000, toTs),
                `${label} page ${page}`,
            );

            if (result.candles.length === 0) {
                emptyPages++;
                if (emptyPages >= 2) break; // Two consecutive empty pages = no more data
                toTs = result.timeFrom - 1;
                await ccSleep(CC_RATE_LIMIT_MS);
                continue;
            }
            emptyPages = 0;

            // Filter out current in-progress candle
            const currentBucket = Math.floor(nowSec / candleSeconds) * candleSeconds;
            const completed = result.candles.filter((c) => c.time < currentBucket);

            if (completed.length > 0) {
                const inserted = await insertCandles(pair.id, "1h", completed);
                totalInserted += inserted;

                const oldest = completed[0]!;
                const newest = completed[completed.length - 1]!;
                console.log(`${label}: page ${page}, ${completed.length} candles (${new Date(oldest.time * 1000).toISOString().slice(0, 10)} → ${new Date(newest.time * 1000).toISOString().slice(0, 10)}), ${inserted} new`);

                // Stop if we've reached existing data or the coin's beginning
                if (range.stopAt > 0 && oldest.time <= range.stopAt) break;
            }

            // If fewer than expected, we've reached the beginning
            if (result.candles.length < 2000) break;

            // Page backwards: set toTs to the earliest candle's time
            toTs = result.timeFrom;

            await ccSleep(CC_RATE_LIMIT_MS);
        }
    }

    if (totalInserted > 0) {
        console.log(`${label}: done — ${totalInserted} candles inserted`);
    } else {
        console.log(`${label}: up to date`);
    }

    return totalInserted;
}

// ═══════════════════════════════════════════════════════════════
// Phase 2: Coinbase — recent granular data (15m, 5m, 1m)
// ═══════════════════════════════════════════════════════════════

interface CoinbasePlan {
    ourTf: string;
    granularity: CoinbaseGranularity;
    candleSeconds: number;
    lookbackSeconds: number;
}

const COINBASE_PLANS: CoinbasePlan[] = [
    { ourTf: "15m", ...TF_TO_GRANULARITY["15m"]!, lookbackSeconds: NINETY_DAYS },
    { ourTf: "5m",  ...TF_TO_GRANULARITY["5m"]!,  lookbackSeconds: THIRTY_DAYS },
    { ourTf: "1m",  ...TF_TO_GRANULARITY["1m"]!,  lookbackSeconds: SEVEN_DAYS },
];

const CB_MAX_CANDLES = 300;

async function backfillCoinbaseTf(pair: PairInfo, plan: CoinbasePlan): Promise<number> {
    const productId = CB_PAIR_MAP[pair.symbol]!;
    const label = `[${pair.symbol}] ${plan.ourTf} (CB)`;
    const nowSec = Math.floor(Date.now() / 1000);
    const depthFloor = nowSec - plan.lookbackSeconds;

    const oldestExisting = await getOldestCandleTs(pair.id, plan.ourTf);
    const latestExisting = await getLatestCandleTs(pair.id, plan.ourTf);

    // Gap-fill ranges
    const ranges: Array<{ start: number; end: number; direction: string }> = [];

    if (oldestExisting === 0) {
        ranges.push({ start: depthFloor, end: nowSec, direction: "full" });
    } else {
        if (oldestExisting > depthFloor + plan.candleSeconds) {
            ranges.push({ start: depthFloor, end: oldestExisting, direction: "backwards" });
        }
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
        console.log(`${label} [${range.direction}]: ~${windowCandles} candles (${new Date(range.start * 1000).toISOString().slice(0, 10)} → ${new Date(range.end * 1000).toISOString().slice(0, 10)})`);

        let cursor = range.start;
        let page = 0;

        while (cursor < range.end && !stopping) {
            page++;
            const pageEnd = Math.min(cursor + CB_MAX_CANDLES * plan.candleSeconds, range.end);

            const candles = await withRetry(
                () => fetchCoinbaseCandles(productId, plan.granularity, cursor, pageEnd),
                `${label} page ${page}`,
            );

            const currentBucket = Math.floor(nowSec / plan.candleSeconds) * plan.candleSeconds;
            const completed = candles.filter((c) => c.time < currentBucket);

            if (completed.length > 0) {
                const inserted = await insertCandles(pair.id, plan.ourTf, completed);
                totalInserted += inserted;

                const newest = completed[completed.length - 1]!;
                console.log(`${label}: page ${page}, fetched ${completed.length}, inserted ${inserted}, latest ${new Date(newest.time * 1000).toISOString()}`);
            }

            cursor = pageEnd;
            await cbSleep(CB_RATE_LIMIT_MS);
        }
    }

    if (totalInserted > 0) {
        console.log(`${label}: done — ${totalInserted} candles inserted`);
    }

    return totalInserted;
}

// ═══════════════════════════════════════════════════════════════
// Phase 3: 4h rollup from 1h data
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
    console.log("=== Historical Candle Backfill ===");
    console.log("    Phase 1: CryptoCompare (1d full history, 1h full history)");
    console.log("    Phase 2: Coinbase (15m 90d, 5m 30d, 1m 7d)");
    console.log("    Phase 3: 4h rollup from 1h\n");

    const pairs = await loadPairs();
    if (pairs.length === 0) {
        console.log("No active pairs found. Run pnpm seed first.");
        process.exitCode = 1;
        return;
    }

    console.log(`Found ${pairs.length} pairs: ${pairs.map((p) => p.symbol).join(", ")}\n`);

    const startTime = Date.now();
    let grandTotal = 0;

    for (const pair of pairs) {
        if (stopping) break;
        console.log(`\n${"═".repeat(50)}`);
        console.log(`  ${pair.symbol}`);
        console.log(`${"═".repeat(50)}`);

        // Phase 1: CryptoCompare deep history
        try {
            grandTotal += await backfillDailyCC(pair);
        } catch (err) {
            console.error(`[${pair.symbol}] 1d CC: FAILED — ${(err as Error).message}`);
        }

        if (!stopping) {
            try {
                grandTotal += await backfillHourlyCC(pair);
            } catch (err) {
                console.error(`[${pair.symbol}] 1h CC: FAILED — ${(err as Error).message}`);
            }
        }

        // Phase 2: Coinbase recent granular
        for (const plan of COINBASE_PLANS) {
            if (stopping) break;
            try {
                grandTotal += await backfillCoinbaseTf(pair, plan);
            } catch (err) {
                console.error(`[${pair.symbol}] ${plan.ourTf} CB: FAILED — ${(err as Error).message}`);
            }
        }

        // Phase 3: 4h rollup
        if (!stopping) {
            try {
                grandTotal += await rollup4hFromHourly(pair.id, pair.symbol);
            } catch (err) {
                console.error(`[${pair.symbol}] 4h rollup: FAILED — ${(err as Error).message}`);
            }
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n=== Backfill complete — ${grandTotal} candles inserted in ${elapsed}s ===`);
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
