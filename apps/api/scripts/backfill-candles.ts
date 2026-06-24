/**
 * backfill-candles.ts — backfill OHLC candles for an explicit (pair, timeframe, window).
 *
 * Built for Stage 6 Post-Match Replay (Scope B), which reconstructs a completed
 * match candle-by-candle and therefore needs candles covering each match's time
 * span. Unlike the on-boot backfill (last 7 days, all pairs), this targets one
 * arbitrary historical window so a specific match's window can be filled.
 *
 * Source: Coinbase Advanced Trade REST — the same windowed [start,end] fetch the
 * on-boot backfill uses. (Kraken's OHLC endpoint only returns the most recent
 * ~720 candles regardless of `since`, so it cannot serve windows older than
 * ~60h at 5m — useless for already-completed matches. Coinbase serves arbitrary
 * historical ranges.) Reuses insertCandleBatch for the idempotent upsert.
 *
 * Usage:
 *   tsx scripts/backfill-candles.ts --pair BTC/USD --tf 5m --from <iso> --to <iso>
 *   pnpm candles:backfill -- --pair BTC/USD --tf 5m --from 2026-05-27T04:00:00Z --to 2026-05-27T14:00:00Z
 *
 * Idempotent: ON CONFLICT (pair_id, timeframe, ts) DO UPDATE — re-running a
 * window leaves the candle count unchanged.
 */
import "dotenv/config";
import { pool } from "../src/db/pool";
import { insertCandleBatch } from "../src/market/candleBackfill";
import {
    fetchCoinbaseCandles,
    sleep,
    CB_PAIR_MAP,
    TF_TO_GRANULARITY,
} from "../src/marketData/coinbaseRest";

const COINBASE_MAX_PER_REQUEST = 300;
const RATE_LIMIT_MS = 150;
const MAX_RETRIES = 3;

function parseArgs(argv: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a?.startsWith("--")) {
            const key = a.slice(2);
            const val = argv[i + 1];
            if (val === undefined || val.startsWith("--")) {
                throw new Error(`Missing value for --${key}`);
            }
            out[key] = val;
            i++;
        }
    }
    return out;
}

function isoToSec(label: string, iso: string): number {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) throw new Error(`--${label} is not a valid ISO timestamp: "${iso}"`);
    return Math.floor(ms / 1000);
}

async function fetchWithRetry(
    productId: string,
    granularity: Parameters<typeof fetchCoinbaseCandles>[1],
    start: number,
    end: number,
): Promise<Awaited<ReturnType<typeof fetchCoinbaseCandles>>> {
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await fetchCoinbaseCandles(productId, granularity, start, end);
        } catch (err) {
            lastErr = err as Error;
            if (attempt < MAX_RETRIES) await sleep(attempt * 1000);
        }
    }
    throw lastErr;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const pairSymbol = args.pair;
    const tf = args.tf ?? "5m";
    if (!pairSymbol || !args.from || !args.to) {
        throw new Error("Usage: --pair <SYM/USD> --tf <5m> --from <iso> --to <iso>");
    }

    const plan = TF_TO_GRANULARITY[tf];
    if (!plan) {
        throw new Error(`Unsupported --tf "${tf}". Supported: ${Object.keys(TF_TO_GRANULARITY).join(", ")}`);
    }

    const productId = CB_PAIR_MAP[pairSymbol];
    if (!productId) {
        throw new Error(`No Coinbase mapping for pair "${pairSymbol}". Known: ${Object.keys(CB_PAIR_MAP).join(", ")}`);
    }

    const fromSec = isoToSec("from", args.from);
    const toSec = isoToSec("to", args.to);
    if (toSec <= fromSec) throw new Error(`--to must be after --from`);

    const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM trading_pairs WHERE symbol = $1 LIMIT 1`,
        [pairSymbol],
    );
    const pairId = rows[0]?.id;
    if (!pairId) throw new Error(`Pair "${pairSymbol}" not found in trading_pairs`);

    console.log(`Backfilling ${pairSymbol} ${tf} from ${args.from} to ${args.to} (Coinbase ${productId})`);

    let total = 0;
    let cursor = fromSec;
    let page = 0;
    const pageSpan = COINBASE_MAX_PER_REQUEST * plan.candleSeconds;

    while (cursor < toSec) {
        page++;
        const pageEnd = Math.min(cursor + pageSpan, toSec);
        const candles = await fetchWithRetry(productId, plan.granularity, cursor, pageEnd);
        // Keep only candles inside the requested window.
        const inWindow = candles.filter((c) => c.time >= fromSec && c.time <= toSec);
        const inserted = await insertCandleBatch(pairId, tf, inWindow);
        total += inserted;
        console.log(`  page ${page}: fetched ${candles.length}, upserted ${inserted}`);
        cursor = pageEnd;
        await sleep(RATE_LIMIT_MS);
    }

    console.log(`Done: ${total} ${tf} candles upserted for ${pairSymbol}`);
}

main()
    .catch((err) => {
        console.error("Backfill failed:", err instanceof Error ? err.message : err);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
