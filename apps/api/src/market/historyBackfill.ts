/**
 * historyBackfill.ts — re-download candle history for the MARKET_SYMBOLS
 * pairs after the DB recovery (fresh Postgres, empty candles table).
 *
 * Source: Coinbase Advanced Trade public market candles
 *   GET https://api.coinbase.com/api/v3/brokerage/market/products/{id}/candles
 * Verified 2026-10-01 from a US network: no auth, HTTP 200, max 350 candles
 * per request, history back to 2015 (BTC-USD, every granularity incl. 1m),
 * 2016 (ETH-USD), mid-2021 (SOL-USD listing). Coinbase's documented public
 * limit is 10 req/s per IP; we default to 4 req/s. (CryptoCompare, used by
 * the older src/scripts/backfillCandles.ts, now returns 401 without a key.
 * Kraken OHLC only serves the latest ~720 candles. Binance/Bybit are
 * geo-blocked from US Railway.)
 *
 * Depth per timeframe matches the storage budget (retention/storageRetention.ts)
 * so nothing is downloaded only to be deleted by the next retention run:
 *   1d, 1h   full history (from listing)
 *   15m, 5m  RETENTION_CANDLE_{15M,5M}_DAYS (365)
 *   1m       RETENTION_CANDLE_1M_DAYS (30)
 *   4h       rolled up from 1h · 1w rolled up from 1d (no native source)
 *
 * Idempotent: every write is INSERT … ON CONFLICT (pair_id, timeframe, ts)
 * DO UPDATE with exchange values, so re-running never duplicates. It also
 * resumes: pages are fetched oldest → newest and committed per page, so if
 * a series' existing rows already reach back to the window start, only the
 * tail after the newest existing candle is fetched (use force to refetch,
 * e.g. to fill a mid-series gap). The 1d series always re-walks from 2015 —
 * its start is the listing date it is used to discover — which is ~12
 * requests per symbol.
 */
import type { Pool } from "pg";
import { config } from "../config.js";
import { insertCandleBatch } from "./candleBackfill.js";

export const COINBASE_CANDLES_URL = "https://api.coinbase.com/api/v3/brokerage/market/products";

/** Earliest date we ask for when walking "full history" (before any listing). */
export const FULL_HISTORY_START_SEC = Date.UTC(2015, 0, 1) / 1000;

type Granularity = "ONE_MINUTE" | "FIVE_MINUTE" | "FIFTEEN_MINUTE" | "ONE_HOUR" | "ONE_DAY";

export interface TimeframeWindow {
    tf: "1m" | "5m" | "15m" | "1h" | "1d";
    granularity: Granularity;
    candleSeconds: number;
    /** Days back from now; null = full history (from the pair's listing). */
    days: number | null;
}

/** Retention window in days, or the fallback when retention is 0 (keep
 *  forever) — never walk full 1m/5m/15m history by accident. */
function depth(retentionDays: number, fallback: number): number {
    return retentionDays > 0 ? retentionDays : fallback;
}

export function defaultPlan(): TimeframeWindow[] {
    // 1d first: its earliest candle is the listing date, which bounds the
    // full-history walk for 1h (and every other series) — no empty pages.
    return [
        { tf: "1d", granularity: "ONE_DAY", candleSeconds: 86_400, days: null },
        { tf: "1h", granularity: "ONE_HOUR", candleSeconds: 3_600, days: null },
        { tf: "15m", granularity: "FIFTEEN_MINUTE", candleSeconds: 900, days: depth(config.retentionCandle15mDays, 365) },
        { tf: "5m", granularity: "FIVE_MINUTE", candleSeconds: 300, days: depth(config.retentionCandle5mDays, 365) },
        { tf: "1m", granularity: "ONE_MINUTE", candleSeconds: 60, days: depth(config.retentionCandle1mDays, 30) },
    ];
}

export interface Candle {
    time: number;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
}

export interface HistoryBackfillOptions {
    pool: Pool;
    /** trading_pairs.symbol form ("BTC/USD"); defaults to config.marketSymbols. */
    symbols?: Iterable<string>;
    plan?: TimeframeWindow[];
    nowSec?: number;
    /** Lower bound for full-history series (default 2015-01-01). */
    fullHistoryStartSec?: number;
    candlesPerRequest?: number;
    /** Minimum gap between HTTP requests (default 250ms = 4 req/s). */
    minIntervalMs?: number;
    maxRetries?: number;
    force?: boolean;
    dryRun?: boolean;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    log?: (msg: string) => void;
}

export interface SeriesResult {
    symbol: string;
    tf: string;
    requests: number;
    upserted: number;
    fromSec: number;
    resumed: boolean;
}

export interface HistoryBackfillResult {
    series: SeriesResult[];
    rollups: Array<{ symbol: string; tf: "4h" | "1w"; upserted: number }>;
    requests: number;
    durationMs: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Spaces requests at least minIntervalMs apart. */
function makeThrottle(minIntervalMs: number, sleep: (ms: number) => Promise<void>) {
    let last = 0;
    return async () => {
        const wait = last + minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
    };
}

async function fetchPage(
    productId: string,
    w: TimeframeWindow,
    start: number,
    end: number,
    o: Required<Pick<HistoryBackfillOptions, "maxRetries">> & {
        fetchImpl: typeof fetch;
        sleep: (ms: number) => Promise<void>;
        throttle: () => Promise<void>;
    },
): Promise<{ candles: Candle[]; requests: number }> {
    const url = `${COINBASE_CANDLES_URL}/${productId}/candles?granularity=${w.granularity}&start=${start}&end=${end}`;
    let requests = 0;
    for (let attempt = 1; ; attempt++) {
        await o.throttle();
        requests++;
        let res: Response;
        try {
            res = await o.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
        } catch (err) {
            if (attempt > o.maxRetries) throw err;
            await o.sleep(1000 * 2 ** attempt);
            continue;
        }
        if (res.ok) {
            const json = (await res.json()) as { candles?: Array<{ start: string } & Omit<Candle, "time">> };
            const candles = (json.candles ?? [])
                .map((c) => ({ time: Number(c.start), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
                .sort((a, b) => a.time - b.time);
            return { candles, requests };
        }
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt > o.maxRetries) {
            const body = await res.text().catch(() => "");
            throw new Error(`Coinbase ${productId} ${w.granularity} HTTP ${res.status}: ${body.slice(0, 200)}`);
        }
        const retryAfter = Number(res.headers.get("retry-after"));
        await o.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
    }
}

async function seriesBounds(pool: Pool, pairId: string, tf: string): Promise<{ min: number; max: number } | null> {
    const { rows } = await pool.query<{ min: Date | null; max: Date | null }>(
        `SELECT min(ts) AS min, max(ts) AS max FROM candles WHERE pair_id = $1 AND timeframe = $2`,
        [pairId, tf],
    );
    const r = rows[0];
    if (!r?.min || !r.max) return null;
    return { min: Math.floor(r.min.getTime() / 1000), max: Math.floor(r.max.getTime() / 1000) };
}

/** 4h from 1h, UTC-aligned (epoch-floored, independent of session TimeZone). */
async function rollup4h(pool: Pool, pairId: string): Promise<number> {
    const r = await pool.query(
        `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
         SELECT pair_id, '4h', to_timestamp(floor(extract(epoch FROM ts) / 14400) * 14400) AS bucket,
                (array_agg(open ORDER BY ts ASC))[1], max(high), min(low),
                (array_agg(close ORDER BY ts DESC))[1], sum(volume)
         FROM candles
         WHERE pair_id = $1 AND timeframe = '1h'
           AND ts < to_timestamp(floor(extract(epoch FROM now()) / 14400) * 14400)
         GROUP BY pair_id, bucket
         ON CONFLICT (pair_id, timeframe, ts) DO UPDATE SET
             open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
             close = EXCLUDED.close, volume = EXCLUDED.volume`,
        [pairId],
    );
    return r.rowCount ?? 0;
}

/** 1w from 1d, ISO weeks (Monday 00:00 UTC) — same boundaries as candleRollupJob. */
async function rollup1w(pool: Pool, pairId: string): Promise<number> {
    const r = await pool.query(
        `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
         SELECT pair_id, '1w', date_trunc('week', ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
                (array_agg(open ORDER BY ts ASC))[1], max(high), min(low),
                (array_agg(close ORDER BY ts DESC))[1], sum(volume)
         FROM candles
         WHERE pair_id = $1 AND timeframe = '1d'
           AND ts < date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
         GROUP BY pair_id, bucket
         ON CONFLICT (pair_id, timeframe, ts) DO UPDATE SET
             open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
             close = EXCLUDED.close, volume = EXCLUDED.volume`,
        [pairId],
    );
    return r.rowCount ?? 0;
}

export async function runHistoryBackfill(opts: HistoryBackfillOptions): Promise<HistoryBackfillResult> {
    const started = Date.now();
    const pool = opts.pool;
    const symbols = [...(opts.symbols ?? config.marketSymbols)];
    const plan = opts.plan ?? defaultPlan();
    const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
    const fullStart = opts.fullHistoryStartSec ?? FULL_HISTORY_START_SEC;
    const perReq = Math.min(opts.candlesPerRequest ?? 300, 350);
    const sleep = opts.sleep ?? realSleep;
    const log = opts.log ?? (() => {});
    const io = {
        maxRetries: opts.maxRetries ?? 5,
        fetchImpl: opts.fetchImpl ?? fetch,
        sleep,
        throttle: makeThrottle(opts.minIntervalMs ?? 250, sleep),
    };

    const { rows: pairRows } = await pool.query<{ id: string; symbol: string }>(
        `SELECT id, symbol FROM trading_pairs WHERE symbol = ANY($1)`,
        [symbols],
    );
    const pairIdBySymbol = new Map(pairRows.map((r) => [r.symbol, r.id]));
    const missing = symbols.filter((s) => !pairIdBySymbol.has(s));
    if (missing.length > 0) {
        throw new Error(`No trading_pairs row for ${missing.join(", ")} — run migrations first`);
    }

    const result: HistoryBackfillResult = { series: [], rollups: [], requests: 0, durationMs: 0 };

    for (const symbol of symbols) {
        const pairId = pairIdBySymbol.get(symbol)!;
        const productId = symbol.replace("/", "-");
        let listingSec: number | null = null;

        for (const w of plan) {
            const currentBucket = Math.floor(nowSec / w.candleSeconds) * w.candleSeconds;
            let windowStart = w.days === null ? fullStart : nowSec - w.days * 86_400;
            if (listingSec !== null) windowStart = Math.max(windowStart, listingSec);
            windowStart = Math.floor(windowStart / w.candleSeconds) * w.candleSeconds;

            let from = windowStart;
            let resumed = false;
            if (!opts.force) {
                const b = await seriesBounds(pool, pairId, w.tf);
                // Covered from the window start → only the tail is missing.
                if (b && b.min <= windowStart + w.candleSeconds) {
                    from = Math.max(windowStart, b.max + w.candleSeconds);
                    resumed = true;
                }
            }

            const pages = Math.max(0, Math.ceil((currentBucket - from) / (perReq * w.candleSeconds)));
            if (opts.dryRun) {
                log(`[dry-run] ${symbol} ${w.tf}: from ${new Date(from * 1000).toISOString()} → ~${pages} requests`);
                result.series.push({ symbol, tf: w.tf, requests: pages, upserted: 0, fromSec: from, resumed });
                result.requests += pages;
                continue;
            }

            let requests = 0;
            let upserted = 0;
            let cursor = from;
            while (cursor < currentBucket) {
                const end = Math.min(cursor + perReq * w.candleSeconds, currentBucket);
                // Coinbase's end bound is inclusive; end - 1 keeps pages disjoint.
                const page = await fetchPage(productId, w, cursor, end - 1, io);
                requests += page.requests;
                const completed = page.candles.filter((c) => c.time >= cursor && c.time < currentBucket);
                if (completed.length > 0) upserted += await insertCandleBatch(pairId, w.tf, completed);
                cursor = end;
            }

            if (w.tf === "1d") {
                const b = await seriesBounds(pool, pairId, "1d");
                if (b) listingSec = b.min;
            }
            log(`${symbol} ${w.tf}: ${upserted} candles upserted in ${requests} requests` +
                (resumed ? ` (resumed from ${new Date(from * 1000).toISOString()})` : ""));
            result.series.push({ symbol, tf: w.tf, requests, upserted, fromSec: from, resumed });
            result.requests += requests;
        }

        if (!opts.dryRun) {
            const r4 = await rollup4h(pool, pairId);
            const r1w = await rollup1w(pool, pairId);
            result.rollups.push({ symbol, tf: "4h", upserted: r4 }, { symbol, tf: "1w", upserted: r1w });
            log(`${symbol} rollups: 4h ${r4}, 1w ${r1w}`);
        }
    }

    result.durationMs = Date.now() - started;
    return result;
}
