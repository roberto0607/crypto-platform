import Decimal from "decimal.js";
import { D, ZERO, toFixed8 } from "../utils/decimal";
import type { DrawdownPoint } from "./portfolioTypes";

export type EquityEntry = { ts: string; equity_quote: string };

/**
 * Total return % = (end - start) / start * 100
 * Returns ZERO if series has fewer than 2 points or start is zero.
 */
export function computeTotalReturn(series: EquityEntry[]): Decimal {
    if (series.length < 2) return ZERO;
    const start = D(series[0].equity_quote);
    const end = D(series[series.length - 1].equity_quote);
    if (start.eq(ZERO)) return ZERO;
    return end.minus(start).div(start).mul(100);
}

/**
 * Max drawdown % = largest peak-to-trough decline as a negative percentage.
 * Returns ZERO if series has fewer than 2 points.
 */
export function computeMaxDrawdown(series: EquityEntry[]): Decimal {
    if (series.length < 2) return ZERO;
    let peak = D(series[0].equity_quote);
    let maxDd = ZERO;

    for (const pt of series) {
        const eq = D(pt.equity_quote);
        if (eq.gt(peak)) peak = eq;
        if (peak.gt(ZERO)) {
            const dd = eq.minus(peak).div(peak).mul(100);
            if (dd.lt(maxDd)) maxDd = dd;
        }
    }

    return maxDd;
}

/**
 * Current drawdown % = decline from peak to the last point.
 * Returns ZERO if series is empty or peak is zero.
 */
export function computeCurrentDrawdown(series: EquityEntry[]): Decimal {
    if (series.length === 0) return ZERO;
    let peak = ZERO;
    for (const pt of series) {
        const eq = D(pt.equity_quote);
        if (eq.gt(peak)) peak = eq;
    }
    if (peak.eq(ZERO)) return ZERO;
    const last = D(series[series.length - 1].equity_quote);
    return last.minus(peak).div(peak).mul(100);
}

/**
 * Drawdown series: for each point, compute drawdown % from running peak.
 */
export function computeDrawdownSeries(series: EquityEntry[]): DrawdownPoint[] {
    if (series.length === 0) return [];
    let peak = ZERO;
    const result: DrawdownPoint[] = [];

    for (const pt of series) {
        const eq = D(pt.equity_quote);
        if (eq.gt(peak)) peak = eq;
        const ddPct = peak.gt(ZERO)
            ? eq.minus(peak).div(peak).mul(100)
            : ZERO;

        result.push({
            ts: pt.ts,
            drawdown_pct: toFixed8(ddPct),
            equity_quote: pt.equity_quote,
            peak_quote: toFixed8(peak),
        });
    }

    return result;
}
