/**
 * formingCandle.ts — the in-progress (forming) candle for any timeframe,
 * served as the last row of GET /pairs/:pairId/candles with `partial: true`.
 *
 * Stored candles are finished buckets only (the 1m aggregator stores a minute
 * when it closes, the rollup job skips the open bucket), so without this the
 * chart rebuilt the current bar from whatever ticks it saw after loading —
 * its open was the first tick after page load, its range missed everything
 * before. The forming bar here is:
 *
 *   open   previous bar's close (so consecutive bars connect)
 *   high   max(open, every 1m high in the bucket)
 *   low    min(open, every 1m low in the bucket)
 *   close  the newest 1m close in the bucket (stored or the aggregator's open minute)
 *   volume sum of the bucket's 1m volume
 *
 * built from the bucket's stored 1m rows plus the aggregator's open minute.
 */
import type { Pool } from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { getLastClosed, getOpenCandle, seedOpenCandle } from "./candleAggregator.js";
import { fetchOHLC, REST_PAIR_MAP, type OHLCPage } from "./krakenRest.js";
import { logger } from "../observability/logContext.js";

export const TIMEFRAME_SECONDS: Record<string, number> = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
    "1w": 604800,
};

// ISO weeks start Monday 00:00 UTC; the epoch was a Thursday (same offset as
// candleRollupJob.ts and the web chart's bucketTime).
const MONDAY_EPOCH_OFFSET_MS = 3 * 86_400_000;

export function bucketStartMs(nowMs: number, timeframe: string): number {
    const sec = TIMEFRAME_SECONDS[timeframe];
    if (!sec) throw new Error(`unknown timeframe ${timeframe}`);
    const ms = sec * 1000;
    const offset = timeframe === "1w" ? MONDAY_EPOCH_OFFSET_MS : 0;
    return Math.floor((nowMs + offset) / ms) * ms - offset;
}

export interface FormingCandle {
    ts: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
    buy_volume: string;
    sell_volume: string;
    partial: true;
}

const num = (s: string | null | undefined): number | null => (s == null ? null : Number(s));

/**
 * The forming candle for `timeframe` at `nowMs`, or null when the pair has no
 * data at all (nothing in the bucket and no previous close).
 */
export async function getFormingCandle(
    pairId: string,
    timeframe: string,
    nowMs: number = Date.now(),
    db: Pick<Pool, "query"> = defaultPool,
): Promise<FormingCandle | null> {
    const startMs = bucketStartMs(nowMs, timeframe);
    const start = new Date(startMs).toISOString();

    // Stored 1m rows inside the bucket (finished minutes).
    const { rows: [inBucket] } = await db.query<{
        open: string | null; high: string | null; low: string | null; close: string | null;
        volume: string | null; buy_volume: string | null; sell_volume: string | null; last_ts: Date | null;
    }>(
        `SELECT (array_agg(open ORDER BY ts ASC))[1]   AS open,
                MAX(high)::text                        AS high,
                MIN(low)::text                         AS low,
                (array_agg(close ORDER BY ts DESC))[1] AS close,
                SUM(volume)::text                      AS volume,
                SUM(buy_volume)::text                  AS buy_volume,
                SUM(sell_volume)::text                 AS sell_volume,
                MAX(ts)                                AS last_ts
         FROM candles
         WHERE pair_id = $1 AND timeframe = '1m' AND ts >= $2`,
        [pairId, start],
    );

    // Previous close: whichever finished bar before the bucket ends latest —
    // the last stored 1m, the last stored bar of this timeframe (1m can be
    // missing, e.g. past retention), or the aggregator's last closed minute
    // (written a moment ago, maybe not readable yet).
    const { rows: prevRows } = await db.query<{ close: string; end_ms: string }>(
        `(SELECT close::text, (extract(epoch FROM ts) * 1000 + 60000)::bigint::text AS end_ms
            FROM candles WHERE pair_id = $1 AND timeframe = '1m' AND ts < $2
            ORDER BY ts DESC LIMIT 1)
         UNION ALL
         (SELECT close::text, (extract(epoch FROM ts) * 1000 + $3::bigint)::bigint::text AS end_ms
            FROM candles WHERE pair_id = $1 AND timeframe = $4 AND ts < $2
            ORDER BY ts DESC LIMIT 1)`,
        [pairId, start, TIMEFRAME_SECONDS[timeframe]! * 1000, timeframe],
    );
    const prevCandidates = prevRows.map((r) => ({ close: r.close, endMs: Number(r.end_ms) }));
    const closed = getLastClosed(pairId);
    if (closed && closed.minuteKey < startMs) {
        prevCandidates.push({ close: closed.close, endMs: closed.minuteKey + 60_000 });
    }
    const openMinute = getOpenCandle(pairId);
    if (openMinute && openMinute.minuteKey < startMs) {
        // A quiet minute before the bucket that hasn't been flushed yet.
        prevCandidates.push({ close: openMinute.close, endMs: openMinute.minuteKey + 60_000 });
    }
    prevCandidates.sort((a, b) => b.endMs - a.endMs);
    const prevClose = prevCandidates[0]?.close ?? null;

    // Inside the bucket: stored minutes, plus the aggregator's open minute
    // when it's newer than the newest stored one.
    let first = inBucket?.open ?? null;
    let high = num(inBucket?.high);
    let low = num(inBucket?.low);
    let close = inBucket?.close ?? null;
    let volume = num(inBucket?.volume) ?? 0;
    let buyVolume = num(inBucket?.buy_volume) ?? 0;
    let sellVolume = num(inBucket?.sell_volume) ?? 0;
    const lastStoredMs = inBucket?.last_ts ? new Date(inBucket.last_ts).getTime() : null;
    if (openMinute && openMinute.minuteKey >= startMs && (lastStoredMs === null || openMinute.minuteKey > lastStoredMs)) {
        first ??= openMinute.open;
        high = Math.max(high ?? -Infinity, Number(openMinute.high));
        low = Math.min(low ?? Infinity, Number(openMinute.low));
        close = openMinute.close;
        volume += Number(openMinute.volume);
        buyVolume += Number(openMinute.buyVolume);
        sellVolume += Number(openMinute.sellVolume);
    }

    const open = prevClose ?? first;
    if (open === null) return null;
    const o = Number(open);
    return {
        ts: start,
        open,
        high: String(Math.max(o, high ?? o)),
        low: String(Math.min(o, low ?? o)),
        close: close ?? open,
        volume: String(volume),
        buy_volume: String(buyVolume),
        sell_volume: String(sellVolume),
        partial: true,
    };
}

/**
 * Boot: seed each Kraken-sourced pair's in-progress minute from Kraken REST's
 * last OHLC entry (the in-progress minute), so the minute the server boots in
 * keeps its real open/range instead of starting at the first tick.
 */
export async function seedOpenCandlesFromKrakenRest(
    pairs: Array<{ pairId: string; symbol: string }>,
    fetchPage: (krakenPair: string, interval: number, since: number) => Promise<OHLCPage> = fetchOHLC,
    nowMs: () => number = Date.now,
): Promise<number> {
    let seeded = 0;
    for (const { pairId, symbol } of pairs) {
        const krakenPair = REST_PAIR_MAP[symbol];
        if (!krakenPair) continue;
        try {
            const page = await fetchPage(krakenPair, 1, Math.floor(nowMs() / 1000) - 120);
            const last = page.candles[page.candles.length - 1];
            const currentMinute = Math.floor(nowMs() / 60_000) * 60_000;
            // Only the entry for the minute we're in is "in progress".
            if (!last || last.time * 1000 !== currentMinute) continue;
            seedOpenCandle(pairId, { minuteKey: currentMinute, ...last });
            seeded++;
        } catch (err) {
            logger.warn({ pair: symbol, err: (err as Error).message }, "forming_candle_seed_failed");
        }
    }
    return seeded;
}
