/**
 * Live (forming-bar) RSI 14, MACD 12/26/9 and ATR 14 without recomputing the
 * whole history on every tick.
 *
 * All three are recursive filters whose value at bar i depends only on bars
 * 0..i, so the full recompute over [closed + forming] is the closed series
 * plus one point. `liveIndicatorState` computes the closed series once (per
 * candle close) and keeps the recursion's state at the last closed bar;
 * `formingIndicators` then takes ONE step with the forming candle, using the
 * same arithmetic, in the same order, as packages/indicators (rsi.ts,
 * macd.ts, atr.ts), so every value is identical (===) to the full recompute.
 * liveIndicators.test.ts checks that at every cut point of real BTC data; if
 * the shared formulas change, that test fails until this file follows.
 *
 * Below each indicator's warm-up (or when the forming bar would be its seed
 * bar) it falls back to the full recompute.
 */
import {
    computeATR,
    computeEMA,
    computeMACD,
    computeRSI,
    type Candle,
    type MACDResult,
    type Point,
} from "./sharedIndicators";
import { withForming } from "./formingCandle";

const RSI_P = 14;
const ATR_P = 14;
const FAST = 12;
const SLOW = 26;
const SIGNAL = 9;

export interface LiveIndicatorToggles {
    rsi: boolean;
    macd: boolean;
    atr: boolean;
}

export interface LiveIndicatorState {
    candles: Candle[];
    on: LiveIndicatorToggles;
    /** The closed series (what the panels show between ticks). */
    closed: { rsi: Point[] | null; macd: MACDResult | null; atr: Point[] | null };
    rsi: { avgGain: number; avgLoss: number } | null;
    macd: { fast: number; slow: number; signal: number } | null;
    atr: number | null;
}

/** RSI's smoothed averages after the last closed bar (rsi.ts's loop, unchanged). */
function rsiAverages(c: Candle[]): { avgGain: number; avgLoss: number } {
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i <= RSI_P; i++) {
        const diff = c[i]!.close - c[i - 1]!.close;
        if (diff > 0) avgGain += diff;
        else avgLoss += Math.abs(diff);
    }
    avgGain /= RSI_P;
    avgLoss /= RSI_P;
    for (let i = RSI_P + 1; i < c.length; i++) {
        const diff = c[i]!.close - c[i - 1]!.close;
        const gain = diff > 0 ? diff : 0;
        const loss = diff < 0 ? Math.abs(diff) : 0;
        avgGain = (avgGain * (RSI_P - 1) + gain) / RSI_P;
        avgLoss = (avgLoss * (RSI_P - 1) + loss) / RSI_P;
    }
    return { avgGain, avgLoss };
}

/** Closed series + recursion state at the last closed bar. Once per history load / candle close. */
export function liveIndicatorState(candles: Candle[], on: LiveIndicatorToggles): LiveIndicatorState {
    const n = candles.length;
    // The forming bar is index n: the step needs it past each seed bar.
    const rsiOk = on.rsi && n >= RSI_P + 1;
    const atrOk = on.atr && n >= ATR_P + 1;
    const macdOk = on.macd && n >= SLOW + SIGNAL;

    const closedAtr = atrOk ? computeATR(candles, ATR_P) : null;
    const closedMacd = macdOk ? computeMACD(candles) : null;
    return {
        candles,
        on,
        closed: { rsi: rsiOk ? computeRSI(candles, RSI_P) : null, macd: closedMacd, atr: closedAtr },
        rsi: rsiOk ? rsiAverages(candles) : null,
        // computeEMA = macd.ts's EMA loops (same seed sum, same step), so its last values are macd.ts's fastEma/slowEma.
        macd: closedMacd
            ? {
                fast: computeEMA(candles, FAST).at(-1)!.value,
                slow: computeEMA(candles, SLOW).at(-1)!.value,
                signal: closedMacd.signal.at(-1)!.value,
            }
            : null,
        // atr.ts's last value is its running `atr`.
        atr: closedAtr ? closedAtr.at(-1)!.value : null,
    };
}

// ── Forming arrays: the closed array + one point, remembered as such ─────

const BASE = new WeakMap<readonly unknown[], readonly unknown[]>();

/** `closed` + `point`, recorded as such so applySeriesData can send just the point. */
export function withFormingPoint<T>(closed: readonly T[], point: T): T[] {
    const out = closed.concat([point]);
    BASE.set(out, closed);
    return out;
}

export interface FormingIndicators {
    rsi: Point[] | null;
    macd: MACDResult | null;
    atr: Point[] | null;
}

/** RSI/MACD/ATR over [closed + forming] — each === its full recompute (null = off or too short). */
export function formingIndicators(s: LiveIndicatorState, f: Candle): FormingIndicators {
    const prev = s.candles[s.candles.length - 1];
    // Not after the last closed bar: withForming overlays it (same time) or drops it (older) — full recompute.
    if (prev && f.time <= prev.time) {
        const series = withForming(s.candles, f);
        return {
            rsi: s.on.rsi && series.length >= RSI_P + 1 ? computeRSI(series, RSI_P) : null,
            macd: s.on.macd && series.length >= SLOW + SIGNAL ? computeMACD(series) : null,
            atr: s.on.atr && series.length >= ATR_P + 1 ? computeATR(series, ATR_P) : null,
        };
    }
    const full = (): Candle[] => [...s.candles, f];
    const n1 = s.candles.length + 1;
    const t = f.time;

    let rsi: Point[] | null = null;
    if (s.on.rsi && n1 >= RSI_P + 1) {
        if (s.rsi && prev) {
            const diff = f.close - prev.close;
            const gain = diff > 0 ? diff : 0;
            const loss = diff < 0 ? Math.abs(diff) : 0;
            const avgGain = (s.rsi.avgGain * (RSI_P - 1) + gain) / RSI_P;
            const avgLoss = (s.rsi.avgLoss * (RSI_P - 1) + loss) / RSI_P;
            const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
            rsi = withFormingPoint(s.closed.rsi!, { time: t, value: 100 - 100 / (1 + rs) });
        } else {
            rsi = computeRSI(full(), RSI_P);
        }
    }

    let atr: Point[] | null = null;
    if (s.on.atr && n1 >= ATR_P + 1) {
        if (s.atr !== null && prev) {
            const pc = prev.close;
            const tr = Math.max(f.high - f.low, Math.abs(f.high - pc), Math.abs(f.low - pc));
            atr = withFormingPoint(s.closed.atr!, { time: t, value: (s.atr * (ATR_P - 1) + tr) / ATR_P });
        } else {
            atr = computeATR(full(), ATR_P);
        }
    }

    let macd: MACDResult | null = null;
    if (s.on.macd && n1 >= SLOW + SIGNAL) {
        if (s.macd) {
            const fastK = 2 / (FAST + 1);
            const slowK = 2 / (SLOW + 1);
            const sigK = 2 / (SIGNAL + 1);
            const fast = f.close * fastK + s.macd.fast * (1 - fastK);
            const slow = f.close * slowK + s.macd.slow * (1 - slowK);
            const m = fast - slow;
            const sig = m * sigK + s.macd.signal * (1 - sigK);
            const c = s.closed.macd!;
            macd = {
                macd: withFormingPoint(c.macd, { time: t, value: m }),
                signal: withFormingPoint(c.signal, { time: t, value: sig }),
                histogram: withFormingPoint(c.histogram, { time: t, value: m - sig }),
            };
        } else {
            macd = computeMACD(full());
        }
    }
    return { rsi, macd, atr };
}

// ── Sending data to a series ───────────────────────────────────────────────

interface SeriesLike<D> {
    setData(data: D[]): void;
    update(point: D): void;
}

const APPLIED = new WeakMap<object, readonly { time: number }[]>();

/**
 * Show `data` on `series`. When `data` is the closed array the series already
 * shows (or showed with a forming point at the same time) plus a forming
 * point, only that point is sent (series.update); anything else is a full
 * setData. Either way the series ends up showing exactly `data`.
 */
export function applySeriesData<P extends { time: number }, D>(
    series: SeriesLike<D>,
    data: readonly P[],
    toLW: (p: P) => D,
): void {
    const prev = APPLIED.get(series);
    APPLIED.set(series, data);
    if (prev === data) return;
    const base = BASE.get(data);
    if (prev && base && data.length > 0) {
        const last = data[data.length - 1]!;
        const prevBase = BASE.get(prev);
        // prev = that closed array → append the point; prev = same closed + a point at the same time → replace it.
        if (prev === base || (prevBase === base && prev[prev.length - 1]!.time === last.time)) {
            series.update(toLW(last));
            return;
        }
    }
    series.setData(data.map(toLW));
}
