/**
 * Chart-side assembly for the price-pane studies: which key levels to show,
 * the UT Bot stop line's colors, and one sorted marker list. No indicator math
 * here — the numbers come from the shared indicators (./indicators).
 */
import type { SeriesMarker, Time } from "lightweight-charts";
import {
    prevPeriodHighLow,
    prevPeriodLevelSeries,
    type Candle,
    type Point,
    type SwingPoint,
    type UTBotSignal,
} from "./indicators";
import type { EMACross } from "./indicators";

export interface KeyLevelPair {
    high: number;
    low: number;
    labels: readonly [string, string];
}

/**
 * Key levels for the last closed candle.
 * - `daily`: the main pair, drawn as the big cards — PDH/PDL, or on 1w the
 *   previous week's (PWH/PWL), as before.
 * - `weekly`: PWH/PWL next to them (not on 1w, which already shows them).
 *   Only when the whole previous Monday–Sunday UTC week is loaded, so a
 *   partial week is never shown as PWH/PWL.
 */
export function keyLevelSets(
    candles: Candle[],
    opts: { timeframe: string; candleSec: number; tzOffsetSec?: number },
): { daily: KeyLevelPair | null; weekly: KeyLevelPair | null } {
    const weekTf = opts.timeframe === "1w";
    const base = { candleSec: opts.candleSec, tzOffsetSec: opts.tzOffsetSec };
    const main = prevPeriodHighLow(candles, { ...base, period: weekTf ? "week" : "day" });
    const daily = main ? { high: main.pdh, low: main.pdl, labels: weekTf ? ["PWH", "PWL"] as const : ["PDH", "PDL"] as const } : null;
    if (weekTf) return { daily, weekly: null };

    const last = candles[candles.length - 1];
    const series = prevPeriodLevelSeries(candles, { ...base, period: "week" });
    const hi = series.high[series.high.length - 1];
    const lo = series.low[series.low.length - 1];
    const weekly = last && hi && lo && hi.time === last.time ? { high: hi.value, low: lo.value, labels: ["PWH", "PWL"] as const } : null;
    return { daily, weekly };
}

export const UT_LONG = "#22c55e";
export const UT_SHORT = "#ef4444";

/** The trailing stop, green while the close is above it (long side), red below. */
export function utBotLine(candles: Candle[], stop: Point[]): Array<{ time: number; value: number; color: string }> {
    const close = new Map(candles.map((c) => [c.time, c.close]));
    return stop.map((p) => ({ time: p.time, value: p.value, color: (close.get(p.time) ?? p.value) >= p.value ? UT_LONG : UT_SHORT }));
}

/**
 * Every marker on the candle series, in one list (the series has one markers
 * plugin, and lightweight-charts needs them in time order): MA golden/death
 * crosses, UT Bot buy/sell signals, swing highs/lows.
 */
export function buildStudyMarkers(src: {
    crosses?: EMACross[];
    utSignals?: UTBotSignal[];
    swings?: { highs: SwingPoint[]; lows: SwingPoint[] };
}): SeriesMarker<Time>[] {
    const out: SeriesMarker<Time>[] = [];
    for (const c of src.crosses ?? []) {
        out.push(c.type === "golden"
            ? { time: c.time as Time, position: "belowBar", shape: "arrowUp", text: "GC", color: "#00ff41" }
            : { time: c.time as Time, position: "aboveBar", shape: "arrowDown", text: "DC", color: "#ff3b3b" });
    }
    for (const s of src.utSignals ?? []) {
        out.push(s.side === "buy"
            ? { time: s.time as Time, position: "belowBar", shape: "arrowUp", text: "Buy", color: UT_LONG }
            : { time: s.time as Time, position: "aboveBar", shape: "arrowDown", text: "Sell", color: UT_SHORT });
    }
    for (const h of src.swings?.highs ?? []) out.push({ time: h.time as Time, position: "aboveBar", shape: "circle", color: "rgba(255,255,255,0.55)", size: 0.5 });
    for (const l of src.swings?.lows ?? []) out.push({ time: l.time as Time, position: "belowBar", shape: "circle", color: "rgba(255,255,255,0.55)", size: 0.5 });
    return out
        .map((m, i) => ({ m, i }))
        .sort((a, b) => (a.m.time as number) - (b.m.time as number) || a.i - b.i)
        .map(({ m }) => m);
}

/**
 * Move a label centered at `y` (half-height `half`) in `dir` (-1 up, +1 down)
 * until it overlaps none of `boxes`, keeping `gap` px from the last one it
 * cleared.
 */
export function nudgeClear(y: number, half: number, boxes: Array<{ top: number; bottom: number }>, dir: -1 | 1, gap: number): number {
    for (let guard = 0; guard <= boxes.length; guard++) {
        const hit = boxes.find((b) => y - half < b.bottom + gap && y + half > b.top - gap);
        if (!hit) return y;
        y = dir < 0 ? hit.top - gap - half : hit.bottom + gap + half;
    }
    return y;
}
