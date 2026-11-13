/**
 * replayClock.ts: the time axis of a match replay (pure, no I/O).
 *
 * The replay used to sample P&L only at 5m candle times inside a ±1h window,
 * and a fill counted only once a candle at or after it existed. So the curve
 * depended on which candles happened to be stored: when the stored 5m
 * candles stopped before the fills, the curve never applied one and sat at
 * 0.00 (prod: Bertito vs berto, a 15-minute match, one candle, both lines flat).
 *
 * Now:
 *   - the candle size follows the match length (replayTimeframe), about 15–60
 *     candles for any match, with coarser candles when the finer ones are gone;
 *   - the clock is the match start, every candle close inside the match,
 *     every event (each fill, for both players) and the match end, so the curve
 *     has a point at every fill and its last point is the match end, whatever
 *     candles exist;
 *   - open size is marked at the latest price known at T: the close of a
 *     candle that has closed by T, or a fill price.
 */
import type { MarkPriceLookup } from "./reconstructPnlCurve";

export const TIMEFRAME_MS = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
} as const;
export type ReplayTimeframe = keyof typeof TIMEFRAME_MS;

/** Finest first: a missing timeframe falls back to the next coarser one. */
export const REPLAY_TIMEFRAMES = Object.keys(TIMEFRAME_MS) as ReplayTimeframe[];

const HOUR = 3_600_000;

/** Candle size for a match this long: 1m up to 1h, 5m up to 6h, 1h beyond. */
export function replayTimeframe(durationMs: number): ReplayTimeframe {
    if (durationMs <= HOUR) return "1m";
    if (durationMs <= 6 * HOUR) return "5m";
    return "1h";
}

/** The preferred timeframe, then each coarser one. */
export function timeframeFallbacks(durationMs: number): ReplayTimeframe[] {
    return REPLAY_TIMEFRAMES.slice(REPLAY_TIMEFRAMES.indexOf(replayTimeframe(durationMs)));
}

export function floorTo(ms: number, bucketMs: number): number {
    return Math.floor(ms / bucketMs) * bucketMs;
}

/** Buckets of `bucketMs` that overlap [startMs, endMs]: [first bucket start, end). */
export function candleWindow(startMs: number, endMs: number, bucketMs: number): { from: number; to: number; buckets: number } {
    const from = floorTo(startMs, bucketMs);
    const to = Math.max(endMs, from + bucketMs);
    return { from, to, buckets: Math.ceil((to - from) / bucketMs) };
}

/**
 * The replay's clock: start, each candle close strictly inside the match,
 * every event clamped into [start, end], end. Ascending, no duplicates.
 */
export function replayClock(startMs: number, endMs: number, candleCloses: number[], eventTimes: number[]): number[] {
    const times = new Set<number>([startMs, endMs]);
    for (const t of candleCloses) if (t > startMs && t < endMs) times.add(t);
    for (const t of eventTimes) times.add(Math.min(endMs, Math.max(startMs, t)));
    return [...times].sort((a, b) => a - b);
}

/**
 * The latest price known at T for a pair: the close of a candle that has
 * closed by T (ts + bucketMs <= T), or a fill at or before T, whichever is
 * later (a fill wins a tie: it's the trade itself). null before either.
 */
export function replayMarkPrice(
    candlesByPair: Map<string, { ts: number; c: number }[]>,
    bucketMs: number,
    fills: { pairId: string; ts: number; price: string }[],
): MarkPriceLookup {
    const series = new Map<string, { t: number; px: number; fill: boolean }[]>();
    const add = (pairId: string, t: number, px: number, fill: boolean) => {
        let s = series.get(pairId);
        if (!s) series.set(pairId, (s = []));
        s.push({ t, px, fill });
    };
    for (const [pairId, candles] of candlesByPair) for (const k of candles) add(pairId, k.ts + bucketMs, k.c, false);
    for (const f of fills) add(f.pairId, f.ts, parseFloat(f.price), true);
    for (const s of series.values()) s.sort((a, b) => a.t - b.t || Number(a.fill) - Number(b.fill));

    return (pairId, T) => {
        const s = series.get(pairId);
        if (!s) return null;
        let lo = 0;
        let hi = s.length - 1;
        let idx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (s[mid]!.t <= T) { idx = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return idx === -1 ? null : s[idx]!.px;
    };
}
