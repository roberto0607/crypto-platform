/**
 * Moving-average lines computed on a higher timeframe (HTF) than the chart,
 * e.g. the daily SMA 200 on a 4h chart. The math and the "closed HTF bars
 * only" rule are the shared ones (packages/indicators htf.ts), the same the
 * API/agents use; this file only picks the inputs and builds what the chart
 * draws. A parity test runs it on the shared fixture against the server's
 * values (lib/__tests__/htfLines.test.ts).
 */
import type { MovingAverageSpec } from "./chartLayouts/catalog";
import {
    TIMEFRAME_SEC,
    computeMovingAverage,
    htfFormingMovingAverage,
    htfStepSeries,
    type Candle,
    type HtfTimeframe,
    type IndicatorTimeframe,
    type Point,
} from "./sharedIndicators";

/** "1D", "4H", "1W" — TradingView-style, for labels. */
export function timeframeLabel(tf: string): string {
    return tf.toUpperCase();
}

/**
 * How a line is drawn on a chart timeframe:
 * - "chart": on the chart's candles (no timeframe set, or it IS the chart's);
 * - "htf": on that higher timeframe's closed candles, as a step line;
 * - "lower": the line's timeframe is below the chart's — not drawn.
 */
export function lineMode(line: Pick<MovingAverageSpec, "timeframe">, chartTf: string): "chart" | "htf" | "lower" {
    const tf = line.timeframe;
    if (!tf || tf === "chart") return "chart";
    const chartSec = TIMEFRAME_SEC[chartTf as IndicatorTimeframe];
    const sec = TIMEFRAME_SEC[tf];
    if (chartSec === undefined || sec === chartSec) return "chart";
    return sec > chartSec ? "htf" : "lower";
}

/** "SMA 200", or "SMA 200 (1D)" when the line has its own timeframe. */
export function movingAverageLabel(line: Pick<MovingAverageSpec, "type" | "length" | "timeframe">): string {
    const base = `${line.type} ${line.length}`;
    return line.timeframe && line.timeframe !== "chart" ? `${base} (${timeframeLabel(line.timeframe)})` : base;
}

/**
 * Closed HTF bars to load: the line's warm-up plus the span of chart bars it
 * is drawn over. EMA gets 5× its length so the seed has decayed to <1% like
 * TradingView's full-history EMA (SMA needs exactly its length).
 */
export function htfBarsNeeded(line: Pick<MovingAverageSpec, "type" | "length">, chartCandles: Candle[], htfSec: number): number {
    const first = chartCandles[0];
    const last = chartCandles[chartCandles.length - 1];
    const span = first && last ? Math.ceil((last.time - first.time) / htfSec) + 2 : 2;
    return (line.type === "EMA" ? 5 : 1) * line.length + span;
}

export interface HtfLine {
    /** One point per chart bar: the value of the HTF bar that had closed by the bar's open. */
    step: Point[];
    /**
     * The forming HTF bar's value if it closed at the last chart close, from
     * the first chart bar inside that HTF bar to the last one. Null when the
     * chart's last bar isn't in the bar after the last closed HTF one (the
     * HTF candles are about to refresh).
     */
    forming: { from: number; to: number; value: number } | null;
}

/**
 * The line on the chart. `chartCandles` = the chart's CLOSED candles;
 * `htfClosed` = closed HTF candles; both on the same clock (the chart's
 * display-shifted times — the shift cancels out).
 */
export function buildHtfLine(
    line: Pick<MovingAverageSpec, "type" | "length">,
    tf: HtfTimeframe,
    chartCandles: Candle[],
    htfClosed: Candle[],
): HtfLine {
    const sec = TIMEFRAME_SEC[tf];
    const pts = computeMovingAverage(htfClosed, line.type, line.length);
    const step = htfStepSeries(pts, sec, chartCandles.map((c) => c.time));

    let forming: HtfLine["forming"] = null;
    const lastHtf = htfClosed[htfClosed.length - 1];
    const lastBar = chartCandles[chartCandles.length - 1];
    if (lastHtf && lastBar) {
        const formingOpen = lastHtf.time + sec;
        if (lastBar.time >= formingOpen && lastBar.time < formingOpen + sec) {
            const value = htfFormingMovingAverage(htfClosed, sec, line, lastBar.close);
            const from = chartCandles.find((c) => c.time >= formingOpen)!.time;
            if (value !== null) forming = { from, to: lastBar.time, value };
        }
    }
    return { step, forming };
}
