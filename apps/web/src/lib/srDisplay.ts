/**
 * Support & resistance on the chart: what to draw and how. The levels come
 * from the shared math (packages/indicators supportResistance.ts, the same the
 * API/agents use); this file only picks which are drawn in full, labels them,
 * and finds the banner state. No React, no chart objects.
 *
 * Display rules:
 * - the `nearest` active levels above and below price are drawn in full; other
 *   active levels faded, stale ones (max age on) faded and labeled "old";
 * - broken levels are faded and end at their break bar (at most the 30 most
 *   recent; hidden when "show broken" is off);
 * - a flip is its own level, in its new role's color from the break bar on;
 * - higher-timeframe levels are dashed and tagged "1D"/"1W";
 * - only full levels carry a right-edge label (srLabelled), so labels never
 *   pile up on the price axis; faded and "old" levels draw line + zone only.
 * - the chart's pivot length is Auto per timeframe unless set by hand there
 *   (srParamsForTimeframe; the HTF levels keep htfLeft/htfRight).
 */
import type { ChartTimeframe, SupportResistanceOptions, SupportResistanceParams, SupportResistancePivot } from "./chartLayouts/catalog";
import { srPivotFor } from "./chartLayouts/layoutConfig";
import {
    TIMEFRAME_SEC,
    computePineATR,
    computeSupportResistance,
    srHtfLevelsAt,
    type Candle,
    type IndicatorTimeframe,
    type SRLevel,
    type SRParams,
    type SRRole,
} from "./sharedIndicators";

export const SR_COLORS: Readonly<Record<SRRole, string>> = { resistance: "#ef4444", support: "#22c55e" };
export const SR_MAX_BROKEN = 30;
/** "Approaching" when price is within this × ATR(14) of a full level's zone. */
export const SR_APPROACH_ATR = 0.5;

export type SRTag = "1D" | "1W";

/** The shared math's params from the saved settings (chart timeframe, or the HTF pivot lengths). */
export function srComputeOpts(p: SupportResistanceParams, o: SupportResistanceOptions, htf = false): Partial<SRParams> {
    return {
        left: htf ? p.htfLeft : p.left,
        right: htf ? p.htfRight : p.right,
        mergeAtr: p.mergeAtr,
        breakAtr: p.breakAtr,
        maxZoneAtr: p.maxZoneAtr,
        volumeFilter: o.volumeFilter === "on",
        volumeMult: p.volumeMult,
        maxAge: o.maxAge === "on" ? p.maxAgeBars : 0,
    };
}

/** The params with left/right = the pivot length in use on chart timeframe `tf` (Auto or hand-set). */
export function srParamsForTimeframe(
    p: SupportResistanceParams,
    pivots: Partial<Record<ChartTimeframe, SupportResistancePivot>>,
    tf: string,
): SupportResistanceParams {
    const { left, right } = srPivotFor({ supportResistancePivots: pivots }, tf);
    return { ...p, left, right };
}

const letter = (role: SRRole) => (role === "resistance" ? "R" : "S");

/** "R ×3", "S ×2", "R→S ×3" (a broken resistance now support), "1D R ×2", "R ×3 · old". */
export function srLabel(level: SRLevel, tag?: SRTag): string {
    const prev: SRRole = level.role === "resistance" ? "support" : "resistance";
    const role = level.flippedFrom ? `${letter(prev)}→${letter(level.role)}` : letter(level.role);
    const base = `${tag ? `${tag} ` : ""}${role} ×${level.touches.length}`;
    return level.staleIndex !== null ? `${base} · old` : base;
}

export interface SRDrawable {
    id: string;
    role: SRRole;
    price: number;
    top: number;
    bottom: number;
    /** Line start (the pivot bar; a flip: the break bar). */
    fromTime: number;
    /** The break bar, or null = extends to the right edge. */
    toTime: number | null;
    broken: boolean;
    emphasis: "full" | "faded";
    color: string;
    dashed: boolean;
    label: string;
}

export function buildSRDrawables(input: {
    levels: SRLevel[];
    price: number;
    nearest: number;
    showBroken: boolean;
    tag?: SRTag;
}): SRDrawable[] {
    const { levels, price, nearest, showBroken, tag } = input;
    const live = levels.filter((l) => l.brokenIndex === null && l.staleIndex === null);
    const byDistance = (a: SRLevel, b: SRLevel) => Math.abs(a.price - price) - Math.abs(b.price - price);
    const full = new Set([
        ...live.filter((l) => l.price >= price).sort(byDistance).slice(0, nearest),
        ...live.filter((l) => l.price < price).sort(byDistance).slice(0, nearest),
    ].map((l) => l.id));

    const broken = levels
        .filter((l) => l.brokenTime !== null)
        .sort((a, b) => b.brokenTime! - a.brokenTime!)
        .slice(0, showBroken ? SR_MAX_BROKEN : 0);
    const shown = new Set([...levels.filter((l) => l.brokenIndex === null), ...broken].map((l) => l.id));

    return levels.filter((l) => shown.has(l.id)).map((l) => ({
        id: tag ? `${tag}:${l.id}` : l.id,
        role: l.role,
        price: l.price,
        top: l.top,
        bottom: l.bottom,
        fromTime: l.createdTime,
        toTime: l.brokenTime,
        broken: l.brokenIndex !== null,
        emphasis: full.has(l.id) ? "full" : "faded",
        color: SR_COLORS[l.role],
        dashed: tag !== undefined,
        label: srLabel(l, tag),
    }));
}

/** Whether a level gets a right-edge label: full strength and unbroken only. */
export function srLabelled(d: SRDrawable): boolean {
    return !d.broken && d.emphasis === "full";
}

export interface SRBanner {
    role: SRRole;
    price: number;
    label: string;
}

/** The nearest full level whose zone is within 0.5 × ATR of `price` (inside the zone counts), or null. */
export function srApproach(drawables: SRDrawable[], price: number, atr: number): SRBanner | null {
    if (!(atr > 0) || !(price > 0)) return null;
    let best: { d: SRDrawable; dist: number } | null = null;
    for (const d of drawables) {
        if (d.emphasis !== "full" || d.broken) continue;
        const dist = price > d.top ? price - d.top : price < d.bottom ? d.bottom - price : 0;
        if (dist <= SR_APPROACH_ATR * atr && (!best || dist < best.dist)) best = { d, dist };
    }
    return best ? { role: best.d.role, price: best.d.price, label: best.d.label } : null;
}

/** The level bar `index` broke (the most-touched if several) — the BROKE banner on that close. */
export function srBrokeAt(levels: SRLevel[], index: number): SRLevel | null {
    let best: SRLevel | null = null;
    for (const l of levels) {
        if (l.brokenIndex === index && (!best || l.touches.length > best.touches.length)) best = l;
    }
    return best;
}

/** One marker per break, in time order: up through a resistance, down through a support. */
export function srBreakMarkers(levels: SRLevel[]): Array<{ time: number; direction: "up" | "down" }> {
    return levels
        .filter((l) => l.brokenTime !== null)
        .map((l) => ({ time: l.brokenTime!, direction: l.role === "resistance" ? "up" as const : "down" as const }))
        .sort((a, b) => a.time - b.time);
}

/** "40h", "10d", "5w", "2.5h", "50m". */
export function formatConfirmDelay(sec: number): string {
    if (sec >= 2 * 604_800 && sec % 604_800 === 0) return `${sec / 604_800}w`;
    if (sec >= 2 * 86_400 && sec % 86_400 === 0) return `${sec / 86_400}d`;
    if (sec >= 3_600) return `${Number((sec / 3_600).toFixed(1))}h`;
    return `${Math.round(sec / 60)}m`;
}

/** Higher timeframes the HTF switch adds, keeping only those above the chart's. */
export function srHtfTimeframes(o: SupportResistanceOptions, chartTf: string): Array<"1d" | "1w"> {
    const chartSec = TIMEFRAME_SEC[chartTf as IndicatorTimeframe] ?? 0;
    const tfs: Array<"1d" | "1w"> = o.htf === "1d+1w" ? ["1d", "1w"] : o.htf === "off" ? [] : [o.htf];
    return tfs.filter((tf) => TIMEFRAME_SEC[tf] > chartSec);
}

/** Settings-panel lines: how late a level is known on the chart and on each HTF shown. */
export function srConfirmText(p: SupportResistanceParams, o: SupportResistanceOptions, chartTf: string): string[] {
    const chartSec = TIMEFRAME_SEC[chartTf as IndicatorTimeframe];
    const out = chartSec ? [`confirms after ${formatConfirmDelay(p.right * chartSec)}`] : [];
    for (const tf of srHtfTimeframes(o, chartTf)) {
        out.push(`${tf.toUpperCase()} confirms after ${formatConfirmDelay(p.htfRight * TIMEFRAME_SEC[tf])}`);
    }
    return out;
}

export interface SRChartState {
    drawables: SRDrawable[];
    /** ATR(14) at the last closed bar (the "approaching" distance unit). */
    atr: number;
    /** The level the last closed bar broke, or null. */
    broke: SRBanner | null;
    /** Break markers (chart-timeframe levels only). */
    breaks: Array<{ time: number; direction: "up" | "down" }>;
}

/**
 * Everything the chart draws for S/R, from its CLOSED candles and the closed
 * candles of each higher timeframe shown (all on the chart's clock). HTF levels
 * are those known when the chart's forming bar opened (srHtfLevelsAt: only
 * HTF bars that had closed by then).
 */
export function srChartState(input: {
    candles: Candle[];
    htf: Array<{ tf: "1d" | "1w"; candles: Candle[] }>;
    params: SupportResistanceParams;
    options: SupportResistanceOptions;
    chartTf: string;
}): SRChartState {
    const { candles, params, options } = input;
    const last = candles[candles.length - 1];
    if (!last) return { drawables: [], atr: 0, broke: null, breaks: [] };
    const show = { price: last.close, nearest: params.nearest, showBroken: options.showBroken === "on" };

    const levels = computeSupportResistance(candles, srComputeOpts(params, options));
    const drawables = buildSRDrawables({ levels, ...show });
    const formingOpen = last.time + (TIMEFRAME_SEC[input.chartTf as IndicatorTimeframe] ?? 0);
    for (const { tf, candles: htfCandles } of input.htf) {
        const all = computeSupportResistance(htfCandles, srComputeOpts(params, options, true));
        const known = srHtfLevelsAt(all, htfCandles.map((c) => c.time), TIMEFRAME_SEC[tf], formingOpen);
        drawables.push(...buildSRDrawables({ levels: known, ...show, tag: tf === "1d" ? "1D" : "1W" }));
    }

    const brokeLevel = srBrokeAt(levels, candles.length - 1);
    return {
        drawables,
        atr: computePineATR(candles, 14).at(-1)?.value ?? 0,
        broke: brokeLevel ? { role: brokeLevel.role, price: brokeLevel.price, label: srLabel(brokeLevel) } : null,
        breaks: show.showBroken ? srBreakMarkers(levels) : [],
    };
}
