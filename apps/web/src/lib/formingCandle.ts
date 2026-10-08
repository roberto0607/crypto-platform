/**
 * formingCandle.ts — pure rules for the trade chart's live (forming) bar.
 *
 * The chart's series is [closed history bars..., forming bar]. Live data
 * arrives on two paths — price.tick (extends the forming bar) and
 * candle.closed (the server's finished bar for a bucket) — and neither may
 * ever rewrite a bar older than the series' last one: lightweight-charts'
 * `series.update()` throws "Cannot update oldest data" for an older time, and
 * a bar that's already on screen must not be reset to a one-tick bar.
 *
 * All times here are chart times (epoch seconds, already TZ-offset), so the
 * caller converts once and these helpers just compare numbers.
 */
import type { Timeframe } from "@/api/endpoints/candles";

export interface Bar {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
}

// Unix epoch (1970-01-01T00:00:00Z) was a Thursday. Naive epoch-second
// flooring by a 7-day interval therefore aligns to Thursdays, not the
// ISO-8601 Monday-start week the backend's 1w candles use (date_trunc('week',
// ts) in candleBackfill.ts / scripts/backfillCandles.ts, and the same
// Monday-offset fix in candleRollupJob.ts). Without this offset the live
// forming candle for "1w" would sit in a different bucket than the historical
// weekly candles fetched from the API.
const MONDAY_EPOCH_OFFSET_SEC = 3 * 24 * 60 * 60;

/** Bucket an epoch-second timestamp to the start of its timeframe period. */
export function bucketTime(epochSec: number, tf: Timeframe): number {
    switch (tf) {
        case "1m":  return Math.floor(epochSec / 60) * 60;
        case "5m":  return Math.floor(epochSec / 300) * 300;
        case "15m": return Math.floor(epochSec / 900) * 900;
        case "1h":  return Math.floor(epochSec / 3600) * 3600;
        case "4h":  return Math.floor(epochSec / 14400) * 14400;
        case "1d":  return Math.floor(epochSec / 86400) * 86400;
        case "1w":  return Math.floor((epochSec + MONDAY_EPOCH_OFFSET_SEC) / 604800) * 604800 - MONDAY_EPOCH_OFFSET_SEC;
        default:    return Math.floor(epochSec / 60) * 60;
    }
}

/**
 * Apply one price tick for `bucket` to the forming bar.
 *
 * - A tick for a bucket older than the series' last bar is ignored (null).
 * - Same bucket as the forming bar → extend it.
 * - Same bucket as the last history bar (no newer forming bar) → extend that
 *   bar instead of replacing it with a one-tick bar.
 * - Otherwise a new bucket opens at the previous bar's close (so consecutive
 *   bars connect, same as the API's forming candle), or at this price when
 *   there is no previous bar.
 *
 * Never mutates its inputs; returns the new forming bar.
 */
export function applyTick(
    live: Bar | null,
    lastHistory: Bar | null,
    bucket: number,
    price: number,
): Bar | null {
    const seriesLast = Math.max(live?.time ?? -Infinity, lastHistory?.time ?? -Infinity);
    if (bucket < seriesLast) return null;

    const base =
        live && live.time === bucket ? live
        : lastHistory && lastHistory.time === bucket ? lastHistory
        : null;
    if (base) {
        return {
            time: bucket,
            open: base.open,
            high: Math.max(base.high, price),
            low: Math.min(base.low, price),
            close: price,
        };
    }
    const prev = live && lastHistory ? (live.time > lastHistory.time ? live : lastHistory) : live ?? lastHistory;
    const open = prev ? prev.close : price;
    return { time: bucket, open, high: Math.max(open, price), low: Math.min(open, price), close: price };
}

export interface ClosedPlan {
    /** "append" a new history bar, "replace" the last one, or "ignore" an older bar. */
    history: "append" | "replace" | "ignore";
    /** Safe to `series.update()` — the bar isn't older than the series' last bar. */
    updateSeries: boolean;
    /** The closed bar IS the forming bar's bucket — adopt the server's values. */
    adoptAsLive: boolean;
}

/**
 * Decide what a candle.closed for `closedTime` may touch.
 *
 * A closed bar between the last history bar and a newer forming bar (the usual
 * case — the next bucket's ticks start before the server flushes the previous
 * one) joins history for indicators, but the series is left alone: its bar for
 * that bucket was already drawn from ticks, and updating an older time throws.
 */
export function planClosedCandle(
    closedTime: number,
    lastHistoryTime: number | null,
    liveTime: number | null,
): ClosedPlan {
    const history =
        lastHistoryTime === null || closedTime > lastHistoryTime ? "append"
        : closedTime === lastHistoryTime ? "replace"
        : "ignore";
    if (history === "ignore") return { history, updateSeries: false, adoptAsLive: false };

    const seriesLast = Math.max(lastHistoryTime ?? -Infinity, liveTime ?? -Infinity);
    return {
        history,
        updateSeries: closedTime >= seriesLast,
        adoptAsLive: liveTime !== null && closedTime === liveTime,
    };
}

/**
 * Lay the forming bar onto loaded history: append it when newer, merge it into
 * the last history bar when it's the same bucket (history's open, combined
 * range, the tick's close), drop it when history already ends past it.
 */
export function reconcileForming(
    history: Bar[],
    live: Bar | null,
): { bars: Bar[]; live: Bar | null } {
    if (!live) return { bars: history, live: null };
    const last = history[history.length - 1];
    if (!last || live.time > last.time) return { bars: [...history, live], live };
    if (live.time < last.time) return { bars: history, live: null };
    const merged: Bar = {
        time: last.time,
        open: last.open,
        high: Math.max(last.high, live.high),
        low: Math.min(last.low, live.low),
        close: live.close,
    };
    return { bars: [...history.slice(0, -1), merged], live: merged };
}

/**
 * Append (or overlay) the forming bar onto a time-ordered series without ever
 * producing a duplicate or out-of-order time — the shape lightweight-charts'
 * setData() and the live indicator recompute both need.
 */
export function withForming<T extends { time: number }>(series: T[], live: T | null): T[] {
    if (!live) return series;
    const last = series[series.length - 1];
    if (!last || live.time > last.time) return [...series, live];
    if (live.time === last.time) return [...series.slice(0, -1), live];
    return series;
}
