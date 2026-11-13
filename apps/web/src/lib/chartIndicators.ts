/**
 * Everything the price chart computes for its indicators, from its CLOSED
 * candles, as one pure function — no chart, React or stores. The chart
 * (CandlestickChart renderOverlays) draws the result.
 *
 * Memoized: each piece is cached on exactly the inputs it reads (candle
 * arrays by identity, settings by value), so a toggle, a settings edit or a
 * higher-timeframe load recomputes only what it changes, and unchanged results
 * keep their identity (the chart then skips re-sending them). A new candle
 * array (history load, candle close, pair or timeframe switch) recomputes all
 * of it. With any cache the result equals a fresh compute
 * (chartIndicators.test.ts runs switch/settings/HTF sequences against one).
 */
import type { Candle as ApiCandle } from "@/api/endpoints/candles";
import type { SeriesMarker, Time } from "lightweight-charts";
import {
    computeADX,
    computeATR,
    computeBollingerBands,
    computeCandleDelta,
    computeEMA,
    computeMACD,
    computeRSI,
    computeSMA,
    computeUTBot,
    computeVWAP,
    detectEMACrosses,
    findSwingPoints,
    type ADXResult,
    type Candle,
    type EMACross,
    type MACDResult,
    type Point,
} from "./indicators";
import type {
    AdxParams,
    ChartTimeframe,
    MaCrossSpec,
    MovingAverageSpec,
    SupportResistanceOptions,
    SupportResistanceParams,
    SupportResistancePivot,
    UtBotParams,
} from "./chartLayouts/catalog";
import { computeSupportResistance, type SRLevel, type SRParams, type UTBotResult } from "./sharedIndicators";
import { buildHtfLine, htfBarsNeeded, lineMode, movingAverageLabel, timeframeLabel } from "./htfLines";
import { srChartState, srHtfTimeframes, srParamsForTimeframe, type SRChartState } from "./srDisplay";
import { buildStudyMarkers, keyLevelSets, utBotLine } from "./chartStudies";
import { detectOrderBlocks, type OrderBlock } from "./orderBlocks";
import { computeCVD, type CvdResult } from "./cvd";
import { liveIndicatorState, type LiveIndicatorState } from "./liveIndicators";
import { TIMEFRAME_SECONDS } from "./drawings/measureFormat";
import type { HtfTimeframe } from "./sharedIndicators";

/** An API candle on the chart's clock (viewer-local seconds), numeric. */
export function apiCandleToIndicator(c: ApiCandle, tzOffsetSec: number): Candle {
    return {
        time: new Date(c.ts).getTime() / 1000 + tzOffsetSec,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        volume: parseFloat(c.volume),
    };
}

export const EMPTY_ADX: ADXResult = { plusDI: [], minusDI: [], adx: [] };

// ── Memo cache ─────────────────────────────────────────────────────────────

/**
 * Slots keyed by name; a slot is reused while its deps are the same
 * (Object.is, element by element). `sweep()` drops slots the last run didn't
 * use (a removed line, a switched-off indicator).
 */
export class MemoCache {
    private slots = new Map<string, { deps: readonly unknown[]; value: unknown }>();
    private used = new Set<string>();

    memo<T>(key: string, deps: readonly unknown[], fn: () => T): T {
        this.used.add(key);
        const s = this.slots.get(key);
        if (s && s.deps.length === deps.length && s.deps.every((d, i) => Object.is(d, deps[i]))) return s.value as T;
        const value = fn();
        this.slots.set(key, { deps, value });
        return value;
    }

    sweep(): void {
        for (const k of this.slots.keys()) if (!this.used.has(k)) this.slots.delete(k);
        this.used.clear();
    }

    get size(): number {
        return this.slots.size;
    }
}

// ── Input / output ─────────────────────────────────────────────────────────

export interface ChartIndicatorToggles {
    keyLevels: boolean;
    orderBlocks: boolean;
    cvd: boolean;
    utBot: boolean;
    supportResistance: boolean;
    swings: boolean;
    adx: boolean;
    vwap: boolean;
    bollingerBands: boolean;
    rsi: boolean;
    macd: boolean;
    atr: boolean;
    delta: boolean;
}

export interface ChartIndicatorInput {
    /** The chart's closed candles (API shape), oldest first. */
    candles: ApiCandle[];
    pairId: string | null;
    chartTf: string;
    tzOffsetSec: number;
    toggles: ChartIndicatorToggles;
    movingAverages: MovingAverageSpec[];
    maCross: MaCrossSpec | null;
    adx: AdxParams;
    utBot: UtBotParams;
    srParams: SupportResistanceParams;
    srOptions: SupportResistanceOptions;
    srPivots: Partial<Record<ChartTimeframe, SupportResistancePivot>>;
    /** Closed candles of a higher timeframe, or null while they load (htfCandleCache.peekHtfCandles). */
    peekHtf: (tf: HtfTimeframe, bars: number) => ApiCandle[] | null;
}

export interface MaLineResult {
    id: string;
    color: string;
    /** "htf" = a step line from the higher timeframe. */
    mode: "chart" | "htf" | "lower";
    points: Point[];
    /** The HTF forming bar's value (dotted), when asked for and loaded. */
    forming: { from: number; to: number; value: number } | null;
    label: string;
    byTime: Map<number, number>;
    last: number | null;
}

export interface ChartIndicators {
    candles: Candle[];
    keyLevels: ReturnType<typeof keyLevelSets> | null;
    /** The 3 latest bullish + 3 latest bearish. */
    orderBlocks: OrderBlock[];
    cvd: CvdResult | null;
    movingAverages: MaLineResult[];
    /** Crosses of the chosen pair (or EMA 50/200, for the alert, with none chosen). */
    crosses: EMACross[];
    crossReady: boolean;
    utBot: { result: UTBotResult; line: Array<{ time: number; value: number; color: string }>; byTime: Map<number, number> } | null;
    sr: SRChartState | null;
    markers: SeriesMarker<Time>[];
    adx: ADXResult;
    vwap: Point[] | null;
    bollinger: {
        middle: Point[]; upper: Point[]; lower: Point[];
        fill: Array<{ time: number; upper: number; lower: number }>;
        bandwidth: number | null; squeeze: boolean;
    } | null;
    rsi: Point[] | null;
    macd: MACDResult | null;
    atr: Point[] | null;
    delta: Point[] | null;
    /** Closed RSI/MACD/ATR + their state at the last closed bar, for the forming bar's live values. */
    live: LiveIndicatorState;
}

const key = (v: unknown) => JSON.stringify(v);

/** The chart's indicators for `input`, reusing whatever `cache` holds for unchanged inputs. */
export function computeChartIndicators(input: ChartIndicatorInput, cache: MemoCache = new MemoCache()): ChartIndicators {
    const { candles: raw, chartTf, tzOffsetSec: tz, toggles: on } = input;
    const m = cache.memo.bind(cache);
    const ind = m("ind", [raw, tz], () => raw.map((c) => apiCandleToIndicator(c, tz)));
    // HTF candles converted once per fetched array (keyed by timeframe, which owns the array).
    const htfInd = (tf: HtfTimeframe, rows: ApiCandle[]) => m(`htfInd:${tf}`, [rows, tz], () => rows.map((c) => apiCandleToIndicator(c, tz)));

    const keyLevels = on.keyLevels
        ? m("keyLevels", [ind, chartTf, tz], () => keyLevelSets(ind, {
            timeframe: chartTf,
            candleSec: TIMEFRAME_SECONDS[chartTf as ChartTimeframe],
            tzOffsetSec: tz,
        }))
        : null;

    const orderBlocks = on.orderBlocks
        ? m("orderBlocks", [ind], () => {
            const obs = detectOrderBlocks(ind);
            if (obs.length === 0) return [];
            return [...obs.filter((ob) => ob.type === "bullish").slice(-3), ...obs.filter((ob) => ob.type === "bearish").slice(-3)];
        })
        : [];

    const cvd = on.cvd ? m("cvd", [raw], () => computeCVD(raw)) : null;

    // Moving averages, one per line (a higher-timeframe line is a step line
    // from that timeframe's closed candles; empty until they load).
    const movingAverages: MaLineResult[] = input.movingAverages.map((ma) => {
        const mode = lineMode(ma, chartTf);
        const label = mode === "lower" ? `${movingAverageLabel(ma)} n/a on ${timeframeLabel(chartTf)}` : movingAverageLabel(ma);
        let points: Point[] = [];
        let forming: MaLineResult["forming"] = null;
        if (mode === "chart") {
            points = m(`ma:${ma.id}`, [ind, ma.type, ma.length], () => (ma.type === "SMA" ? computeSMA(ind, ma.length) : computeEMA(ind, ma.length)));
        } else if (mode === "htf" && input.pairId && ma.timeframe && ma.timeframe !== "chart") {
            const tf = ma.timeframe as HtfTimeframe;
            const htf = input.peekHtf(tf, htfBarsNeeded(ma, ind, TIMEFRAME_SECONDS[tf]));
            if (htf) {
                const built = m(`ma:${ma.id}`, [ind, htfInd(tf, htf), ma.type, ma.length, tf], () => buildHtfLine(ma, tf, ind, htfInd(tf, htf)));
                points = built.step;
                if (ma.forming && built.forming) forming = built.forming;
            }
        }
        const byTime = m(`maMap:${ma.id}`, [points], () => new Map(points.map((p) => [p.time, p.value])));
        return { id: ma.id, color: ma.color, mode, points, forming, label, byTime, last: points.at(-1)?.value ?? null };
    });

    // Golden/death crosses between the chosen lines; with none chosen the
    // alert still watches EMA 50/200.
    const lineById = (id: string) => movingAverages.find((l) => l.id === id)?.points ?? [];
    const crossPts = input.maCross
        ? { fast: lineById(input.maCross.fast), slow: lineById(input.maCross.slow) }
        : {
            fast: m("ema50", [ind], () => computeEMA(ind, 50)),
            slow: m("ema200", [ind], () => computeEMA(ind, 200)),
        };
    const crosses = m("crosses", [crossPts.fast, crossPts.slow], () => detectEMACrosses(crossPts.fast, crossPts.slow));

    const utBot = on.utBot
        ? m("utBot", [ind, input.utBot.keyValue, input.utBot.atrPeriod], () => {
            const result = computeUTBot(ind, input.utBot);
            const line = utBotLine(ind, result.stop);
            return { result, line, byTime: new Map(line.map((p) => [p.time, p.value])) };
        })
        : null;

    // Support & resistance (+ 1D/1W levels from their closed candles).
    let sr: SRChartState | null = null;
    if (on.supportResistance) {
        const htf: Array<{ tf: "1d" | "1w"; candles: Candle[] }> = [];
        const first = ind[0]!;
        const last = ind[ind.length - 1]!;
        for (const tf of srHtfTimeframes(input.srOptions, chartTf)) {
            const sec = TIMEFRAME_SECONDS[tf];
            // The span the chart shows + pivot and ATR(14) warm-up.
            const need = Math.ceil((last.time - first.time) / sec) + 2 * (input.srParams.htfLeft + input.srParams.htfRight) + 60;
            const got = input.pairId ? input.peekHtf(tf, need) : null;
            if (got) htf.push({ tf, candles: htfInd(tf, got) });
        }
        const params = srParamsForTimeframe(input.srParams, input.srPivots, chartTf);
        // HTF levels depend only on their own candles + params: cached across chart candle closes.
        const tfOf = new Map(htf.map((h) => [h.candles, h.tf]));
        const htfLevels = (c: Candle[], opts: Partial<SRParams>): SRLevel[] =>
            m(`srHtf:${tfOf.get(c)}`, [c, key(opts)], () => computeSupportResistance(c, opts));
        sr = m("sr", [ind, chartTf, key(params), key(input.srOptions), ...htf.map((h) => h.candles)], () =>
            srChartState({ candles: ind, htf, params, options: input.srOptions, chartTf, htfLevels }));
    }

    const swings = on.swings ? m("swings", [ind], () => findSwingPoints(ind)) : undefined;
    const markerCrosses = input.maCross ? crosses : null;
    const markers = m("markers", [markerCrosses, utBot, swings, sr], () => buildStudyMarkers({
        crosses: markerCrosses ?? [],
        utSignals: utBot?.result.signals ?? [],
        swings,
        srBreaks: sr?.breaks ?? [],
    }));

    const adx = on.adx ? m("adx", [ind, key(input.adx)], () => computeADX(ind, input.adx)) : EMPTY_ADX;
    const vwap = on.vwap ? m("vwap", [ind, tz], () => computeVWAP(ind, tz)) : null;

    const bollinger = on.bollingerBands
        ? m("bollinger", [ind], () => {
            const bb = computeBollingerBands(ind, 20, 2);
            const fill = bb.upper.map((u, i) => ({ time: u.time, upper: u.value, lower: bb.lower[i]!.value }));
            // Squeeze: the latest bandwidth at/near the low of the last 100 bars.
            const bw = bb.middle.map((mid, i) => (mid.value !== 0 ? (bb.upper[i]!.value - bb.lower[i]!.value) / mid.value : 0));
            let bandwidth: number | null = null;
            let squeeze = false;
            if (bw.length > 0) {
                const latest = bw[bw.length - 1]!;
                const lookback = bw.slice(-100);
                const minBw = Math.min(...lookback);
                bandwidth = latest;
                squeeze = lookback.length >= 20 && latest <= minBw * 1.05;
            }
            return { ...bb, fill, bandwidth, squeeze };
        })
        : null;

    // RSI/MACD/ATR: closed series + the state the forming bar steps from.
    const rsiState = m("rsi", [ind, on.rsi], () => liveIndicatorState(ind, { rsi: on.rsi, macd: false, atr: false }));
    const macdState = m("macd", [ind, on.macd], () => liveIndicatorState(ind, { rsi: false, macd: on.macd, atr: false }));
    const atrState = m("atr", [ind, on.atr], () => liveIndicatorState(ind, { rsi: false, macd: false, atr: on.atr }));
    const live = m("live", [rsiState, macdState, atrState], (): LiveIndicatorState => ({
        candles: ind,
        on: { rsi: on.rsi, macd: on.macd, atr: on.atr },
        closed: { rsi: rsiState.closed.rsi, macd: macdState.closed.macd, atr: atrState.closed.atr },
        rsi: rsiState.rsi,
        macd: macdState.macd,
        atr: atrState.atr,
    }));
    // Below the live state's warm-up the panels get the plain (short or empty) series, as before.
    const rsi = on.rsi ? (live.closed.rsi ?? m("rsiShort", [ind], () => computeRSI(ind, 14))) : null;
    const macd = on.macd ? (live.closed.macd ?? m("macdShort", [ind], () => computeMACD(ind))) : null;
    const atr = on.atr ? (live.closed.atr ?? m("atrShort", [ind], () => computeATR(ind, 14))) : null;
    const delta = on.delta ? m("delta", [ind], () => computeCandleDelta(ind)) : null;

    cache.sweep();
    return { candles: ind, keyLevels, orderBlocks, cvd, movingAverages, crosses, crossReady: crossPts.fast.length > 0 && crossPts.slow.length > 0, utBot, sr, markers, adx, vwap, bollinger, rsi, macd, atr, delta, live };
}
