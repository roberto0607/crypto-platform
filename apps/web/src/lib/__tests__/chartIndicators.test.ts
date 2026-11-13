/**
 * Cache correctness: whatever the chart did before (switch pair/timeframe,
 * edit any setting, HTF candles arriving, a candle closing), the memoized
 * result must equal a fresh full recompute — no stale indicator, ever.
 * And the refactor changes no value: a fresh compute equals the maths the
 * chart's renderOverlays ran before (reference() below, copied from it).
 */
import { describe, it, expect } from "vitest";
import type { Candle as ApiCandle } from "@/api/endpoints/candles";
import {
    computeADX, computeATR, computeBollingerBands, computeCandleDelta, computeEMA, computeMACD, computeRSI,
    computeSMA, computeUTBot, computeVWAP, detectEMACrosses, findSwingPoints, type Candle, type Point,
} from "@/lib/indicators";
import { computeChartIndicators, MemoCache, EMPTY_ADX, apiCandleToIndicator, type ChartIndicatorInput } from "@/lib/chartIndicators";
import { DEFAULT_INDICATOR_SETTINGS } from "@/lib/chartLayouts/layoutConfig";
import { buildHtfLine, htfBarsNeeded, lineMode } from "@/lib/htfLines";
import { srChartState, srHtfTimeframes, srParamsForTimeframe } from "@/lib/srDisplay";
import { buildStudyMarkers, keyLevelSets, utBotLine } from "@/lib/chartStudies";
import { detectOrderBlocks } from "@/lib/orderBlocks";
import { computeCVD } from "@/lib/cvd";
import { TIMEFRAME_SECONDS } from "@/lib/drawings/measureFormat";
import type { HtfTimeframe } from "@/lib/sharedIndicators";
import { btcCandles } from "./helpers/btcFixture";

const TZ = -18_000; // a non-zero viewer offset, like the chart's

const toApi = (c: Candle, scale = 1): ApiCandle => ({
    ts: new Date(c.time * 1000).toISOString(),
    open: String(c.open * scale), high: String(c.high * scale), low: String(c.low * scale), close: String(c.close * scale),
    volume: String(c.volume),
});
const series = (tf: "4h" | "1d" | "1w", scale = 1, n?: number) => {
    const all = btcCandles(tf).map((c) => toApi(c, scale));
    return n ? all.slice(0, n) : all;
};

// Two "pairs": real BTC, and the same bars scaled (different prices, same times).
const PAIRS = {
    btc: { "4h": series("4h"), "1d": series("1d"), "1w": series("1w") },
    alt: { "4h": series("4h", 0.05), "1d": series("1d", 0.05), "1w": series("1w", 0.05) },
};

const ALL_ON = {
    keyLevels: true, orderBlocks: true, cvd: true, utBot: true, supportResistance: true, swings: true,
    adx: true, vwap: true, bollingerBands: true, rsi: true, macd: true, atr: true, delta: true,
};

type Htf = Partial<Record<HtfTimeframe, ApiCandle[]>>;

/** One array, like the chart's rawCandlesRef between candle closes. */
const BTC_4H = PAIRS.btc["4h"].slice(-750, -10);

function makeInput(over: Partial<ChartIndicatorInput> & { htf?: Htf } = {}): ChartIndicatorInput {
    const htf: Htf = over.htf ?? {};
    const { htf: _drop, ...rest } = over;
    void _drop;
    return {
        candles: BTC_4H,
        pairId: "btc",
        chartTf: "4h",
        tzOffsetSec: TZ,
        toggles: { ...ALL_ON },
        movingAverages: [
            { id: "ma1", type: "EMA", length: 20, color: "#f59e0b" },
            { id: "ma2", type: "EMA", length: 50, color: "#3b82f6" },
            { id: "ma3", type: "SMA", length: 200, color: "#a855f7" },
            { id: "ma4", type: "SMA", length: 200, color: "#ec4899", timeframe: "1d", forming: true },
            { id: "ma5", type: "SMA", length: 50, color: "#14b8a6", timeframe: "1w" },
        ],
        maCross: { fast: "ma2", slow: "ma3" },
        adx: { ...DEFAULT_INDICATOR_SETTINGS.adx },
        utBot: { ...DEFAULT_INDICATOR_SETTINGS.utBot },
        srParams: { ...DEFAULT_INDICATOR_SETTINGS.supportResistance },
        srOptions: { ...DEFAULT_INDICATOR_SETTINGS.supportResistanceOptions, htf: "1d+1w" },
        srPivots: {},
        peekHtf: (tf) => htf[tf] ?? null,
        ...rest,
    };
}

/** The maths renderOverlays ran before this change, call for call. */
function reference(input: ChartIndicatorInput) {
    const ind = input.candles.map((c) => apiCandleToIndicator(c, input.tzOffsetSec));
    const on = input.toggles;
    const chartTf = input.chartTf;
    const maPoints = new Map<string, Point[]>();
    const forming = new Map<string, unknown>();
    for (const ma of input.movingAverages) {
        const mode = lineMode(ma, chartTf);
        let pts: Point[] = [];
        if (mode === "chart") pts = ma.type === "SMA" ? computeSMA(ind, ma.length) : computeEMA(ind, ma.length);
        else if (mode === "htf" && input.pairId && ma.timeframe && ma.timeframe !== "chart") {
            const tf = ma.timeframe as HtfTimeframe;
            const htf = input.peekHtf(tf, htfBarsNeeded(ma, ind, TIMEFRAME_SECONDS[tf]));
            if (htf) {
                const built = buildHtfLine(ma, tf, ind, htf.map((c) => apiCandleToIndicator(c, input.tzOffsetSec)));
                pts = built.step;
                if (ma.forming && built.forming) forming.set(ma.id, built.forming);
            }
        }
        maPoints.set(ma.id, pts);
    }
    const crossPts = input.maCross
        ? { fast: maPoints.get(input.maCross.fast) ?? [], slow: maPoints.get(input.maCross.slow) ?? [] }
        : { fast: computeEMA(ind, 50), slow: computeEMA(ind, 200) };
    const crosses = detectEMACrosses(crossPts.fast, crossPts.slow);
    const ut = on.utBot ? computeUTBot(ind, input.utBot) : null;
    let sr = null;
    if (on.supportResistance) {
        const htf: Array<{ tf: "1d" | "1w"; candles: Candle[] }> = [];
        const first = ind[0]!;
        const last = ind[ind.length - 1]!;
        for (const tf of srHtfTimeframes(input.srOptions, chartTf)) {
            const sec = TIMEFRAME_SECONDS[tf];
            const need = Math.ceil((last.time - first.time) / sec) + 2 * (input.srParams.htfLeft + input.srParams.htfRight) + 60;
            const got = input.pairId ? input.peekHtf(tf, need) : null;
            if (got) htf.push({ tf, candles: got.map((c) => apiCandleToIndicator(c, input.tzOffsetSec)) });
        }
        sr = srChartState({ candles: ind, htf, params: srParamsForTimeframe(input.srParams, input.srPivots, chartTf), options: input.srOptions, chartTf });
    }
    const markers = buildStudyMarkers({
        crosses: input.maCross ? crosses : [],
        utSignals: ut?.signals ?? [],
        swings: on.swings ? findSwingPoints(ind) : undefined,
        srBreaks: sr?.breaks ?? [],
    });
    const obs = on.orderBlocks ? detectOrderBlocks(ind) : [];
    const bb = on.bollingerBands ? computeBollingerBands(ind, 20, 2) : null;
    return {
        ma: input.movingAverages.map((ma) => ({ id: ma.id, points: maPoints.get(ma.id), forming: forming.get(ma.id) ?? null })),
        crosses,
        ut: ut ? { result: ut, line: utBotLine(ind, ut.stop) } : null,
        sr,
        markers,
        keyLevels: on.keyLevels ? keyLevelSets(ind, { timeframe: chartTf, candleSec: TIMEFRAME_SECONDS[chartTf as "4h"], tzOffsetSec: input.tzOffsetSec }) : null,
        orderBlocks: obs.length > 0 ? [...obs.filter((o) => o.type === "bullish").slice(-3), ...obs.filter((o) => o.type === "bearish").slice(-3)] : [],
        cvd: on.cvd ? computeCVD(input.candles) : null,
        adx: on.adx ? computeADX(ind, input.adx) : EMPTY_ADX,
        vwap: on.vwap ? computeVWAP(ind, input.tzOffsetSec) : null,
        bb: bb ? { middle: bb.middle, upper: bb.upper, lower: bb.lower } : null,
        rsi: on.rsi ? computeRSI(ind, 14) : null,
        macd: on.macd ? computeMACD(ind) : null,
        atr: on.atr ? computeATR(ind, 14) : null,
        delta: on.delta ? computeCandleDelta(ind) : null,
    };
}

function view(r: ReturnType<typeof computeChartIndicators>) {
    return {
        ma: r.movingAverages.map((l) => ({ id: l.id, points: l.points, forming: l.forming })),
        crosses: r.crosses,
        ut: r.utBot ? { result: r.utBot.result, line: r.utBot.line } : null,
        sr: r.sr, markers: r.markers, keyLevels: r.keyLevels, orderBlocks: r.orderBlocks, cvd: r.cvd, adx: r.adx, vwap: r.vwap,
        bb: r.bollinger ? { middle: r.bollinger.middle, upper: r.bollinger.upper, lower: r.bollinger.lower } : null,
        rsi: r.rsi, macd: r.macd, atr: r.atr, delta: r.delta,
    };
}

/** Run a session step by step on ONE cache; every step must equal a fresh compute (and the old maths). */
function session(steps: Array<[string, ChartIndicatorInput]>) {
    const cache = new MemoCache();
    for (const [label, input] of steps) {
        const cached = computeChartIndicators(input, cache);
        const fresh = computeChartIndicators(input, new MemoCache());
        try {
            expect(cached).toStrictEqual(fresh);
            expect(view(fresh)).toStrictEqual(reference(input));
        } catch (e) {
            throw new Error(`step "${label}": ${(e as Error).message.slice(0, 2000)}`);
        }
    }
    return cache;
}

// Each session runs dozens of fresh + reference computes over real data.
describe("memoized chart indicators === a fresh full recompute", { timeout: 120_000 }, () => {
    const HTF_BTC = { "1d": PAIRS.btc["1d"], "1w": PAIRS.btc["1w"] };

    it("HTF candles arriving (one timeframe, then the other), then refetched", () => {
        session([
            ["no HTF yet", makeInput()],
            ["1D arrives", makeInput({ htf: { "1d": HTF_BTC["1d"] } })],
            ["1W arrives", makeInput({ htf: HTF_BTC })],
            ["1D refetched (one more bar)", makeInput({ htf: { "1d": [...HTF_BTC["1d"], toApi({ ...btcCandles("1d").at(-1)!, time: btcCandles("1d").at(-1)!.time + 86_400 })], "1w": HTF_BTC["1w"] } })],
        ]);
    });

    it("every indicator toggled off and back on", () => {
        const steps: Array<[string, ChartIndicatorInput]> = [["all on", makeInput({ htf: HTF_BTC })]];
        for (const k of Object.keys(ALL_ON) as Array<keyof typeof ALL_ON>) {
            steps.push([`${k} off`, makeInput({ htf: HTF_BTC, toggles: { ...ALL_ON, [k]: false } })]);
            steps.push([`${k} on`, makeInput({ htf: HTF_BTC })]);
        }
        steps.push(["all off", makeInput({ htf: HTF_BTC, toggles: Object.fromEntries(Object.keys(ALL_ON).map((k) => [k, false])) as typeof ALL_ON, movingAverages: [], maCross: null })]);
        steps.push(["all on again", makeInput({ htf: HTF_BTC })]);
        session(steps);
    });

    it("every setting edited", () => {
        const base = makeInput({ htf: HTF_BTC });
        const mas = base.movingAverages;
        const edits: Array<[string, Partial<ChartIndicatorInput>]> = [
            ["MA length", { movingAverages: mas.map((m) => (m.id === "ma1" ? { ...m, length: 21 } : m)) }],
            ["MA type", { movingAverages: mas.map((m) => (m.id === "ma1" ? { ...m, type: "SMA" as const } : m)) }],
            ["MA color", { movingAverages: mas.map((m) => (m.id === "ma2" ? { ...m, color: "#ffffff" } : m)) }],
            ["MA timeframe chart → 1D", { movingAverages: mas.map((m) => (m.id === "ma3" ? { ...m, timeframe: "1d" as const } : m)) }],
            ["MA HTF 1D → 1W", { movingAverages: mas.map((m) => (m.id === "ma4" ? { ...m, timeframe: "1w" as const } : m)) }],
            ["MA forming off", { movingAverages: mas.map((m) => (m.id === "ma4" ? { ...m, forming: false } : m)) }],
            ["MA forming on (1W line)", { movingAverages: mas.map((m) => (m.id === "ma5" ? { ...m, forming: true } : m)) }],
            ["MA HTF below chart (1h on 4h)", { movingAverages: mas.map((m) => (m.id === "ma5" ? { ...m, timeframe: "1h" as const } : m)) }],
            ["MA removed", { movingAverages: mas.filter((m) => m.id !== "ma2"), maCross: null }],
            ["MA added", { movingAverages: [...mas, { id: "ma6", type: "EMA", length: 9, color: "#06b6d4" }] }],
            ["MA ids swapped", { movingAverages: mas.map((m) => (m.id === "ma1" ? { ...m, id: "ma2" } : m.id === "ma2" ? { ...m, id: "ma1" } : m)) }],
            ["cross other pair", { maCross: { fast: "ma1", slow: "ma4" } }],
            ["no cross", { maCross: null }],
            ["ADX DI length", { adx: { ...base.adx, diLength: 10 } }],
            ["ADX smoothing", { adx: { ...base.adx, adxSmoothing: 20 } }],
            ["ADX threshold", { adx: { ...base.adx, threshold: 30 } }],
            ["UT Bot key", { utBot: { ...base.utBot, keyValue: 2.5 } }],
            ["UT Bot ATR", { utBot: { ...base.utBot, atrPeriod: 14 } }],
            ...(Object.keys(base.srParams) as Array<keyof typeof base.srParams>).map((k): [string, Partial<ChartIndicatorInput>] =>
                [`S/R ${k}`, { srParams: { ...base.srParams, [k]: base.srParams[k] + (k.endsWith("Atr") || k === "volumeMult" ? 0.5 : 2) } }]),
            ["S/R htf 1d", { srOptions: { ...base.srOptions, htf: "1d" } }],
            ["S/R htf off", { srOptions: { ...base.srOptions, htf: "off" } }],
            ["S/R broken off", { srOptions: { ...base.srOptions, showBroken: "off" } }],
            ["S/R volume filter", { srOptions: { ...base.srOptions, volumeFilter: "on" } }],
            ["S/R max age", { srOptions: { ...base.srOptions, maxAge: "on" } }],
            ["S/R pivot by hand on 4h", { srPivots: { "4h": { left: 7, right: 6 } } }],
            ["S/R pivot by hand on another TF", { srPivots: { "1h": { left: 3, right: 3 } } }],
        ];
        const steps: Array<[string, ChartIndicatorInput]> = [["start", base]];
        for (const [label, over] of edits) {
            steps.push([label, makeInput({ htf: HTF_BTC, ...over })]);
            steps.push([`${label} (back)`, base]);
        }
        session(steps);
    });

    it("candle closes, pair switch, timeframe switch and back", () => {
        const btc4h = PAIRS.btc["4h"];
        const n = btc4h.length;
        session([
            ["btc 4h", makeInput({ htf: HTF_BTC, candles: btc4h.slice(n - 760, n - 10) })],
            ["candle close", makeInput({ htf: HTF_BTC, candles: btc4h.slice(n - 760, n - 9) })],
            ["another close", makeInput({ htf: HTF_BTC, candles: btc4h.slice(n - 760, n - 8) })],
            // Same times, other prices, other HTF arrays (and HTF loading again at first).
            ["switch pair, HTF loading", makeInput({ pairId: "alt", candles: PAIRS.alt["4h"].slice(n - 760, n - 8) })],
            ["alt HTF loaded", makeInput({ pairId: "alt", candles: PAIRS.alt["4h"].slice(n - 760, n - 8), htf: { "1d": PAIRS.alt["1d"], "1w": PAIRS.alt["1w"] } })],
            ["switch timeframe to 1D", makeInput({ pairId: "alt", chartTf: "1d", candles: PAIRS.alt["1d"].slice(-750), htf: { "1w": PAIRS.alt["1w"] } })],
            ["switch timeframe to 1W", makeInput({ pairId: "alt", chartTf: "1w", candles: PAIRS.alt["1w"] })],
            ["back to btc 4h", makeInput({ htf: HTF_BTC, candles: btc4h.slice(n - 760, n - 8) })],
            ["no pair", makeInput({ pairId: null, htf: HTF_BTC })],
        ]);
    });

    it("memoizes: an unrelated change keeps every other result's identity; nothing leaks", () => {
        const cache = new MemoCache();
        const a = computeChartIndicators(makeInput({ htf: { "1d": PAIRS.btc["1d"], "1w": PAIRS.btc["1w"] } }), cache);
        const b = computeChartIndicators(makeInput({ htf: { "1d": PAIRS.btc["1d"], "1w": PAIRS.btc["1w"] }, utBot: { keyValue: 2, atrPeriod: 10 } }), cache);
        expect(b.utBot).not.toBe(a.utBot);
        expect(b.markers).not.toBe(a.markers);
        expect(b.movingAverages.map((l) => l.points)).toEqual(a.movingAverages.map((l) => l.points));
        b.movingAverages.forEach((l, i) => expect(l.points).toBe(a.movingAverages[i]!.points));
        for (const k of ["sr", "rsi", "macd", "atr", "adx", "vwap", "bollinger", "keyLevels", "cvd", "delta"] as const) expect(b[k]).toBe(a[k]);
        // HTF candles landing only touch the HTF line + S/R.
        const c0 = computeChartIndicators(makeInput({ htf: { "1d": PAIRS.btc["1d"] } }), cache);
        const c1 = computeChartIndicators(makeInput({ htf: { "1d": PAIRS.btc["1d"], "1w": PAIRS.btc["1w"] } }), cache);
        expect(c1.movingAverages[4]!.points).not.toBe(c0.movingAverages[4]!.points);
        expect(c1.sr).not.toBe(c0.sr);
        for (const i of [0, 1, 2, 3]) expect(c1.movingAverages[i]!.points).toBe(c0.movingAverages[i]!.points);
        for (const k of ["rsi", "macd", "atr", "adx", "vwap", "bollinger", "utBot"] as const) expect(c1[k]).toBe(c0[k]);
        // Turning things off drops their slots.
        const before = cache.size;
        computeChartIndicators(makeInput({ toggles: Object.fromEntries(Object.keys(ALL_ON).map((k) => [k, false])) as typeof ALL_ON, movingAverages: [], maCross: null }), cache);
        expect(cache.size).toBeLessThan(before);
        // Left: candles, RSI/MACD/ATR states + their combination, the EMA 50/200 the cross alert watches, crosses, markers.
        expect(cache.size).toBe(9);
    });
});
