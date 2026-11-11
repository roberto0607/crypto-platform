import { describe, it, expect } from "vitest";
import { CHART_LAYOUT_CATALOG } from "../catalog";
import {
    PANE_IDS,
    PRESETS,
    allIndicators,
    captureConfig,
    isModified,
    resolveConfig,
    type ChartState,
} from "../layoutConfig";
import { DEFAULT_INDICATOR_CONFIG } from "@/stores/tradingStore";
import { DEFAULT_INDICATOR_SETTINGS } from "../layoutConfig";
import { DEFAULT_HEIGHTS } from "@/components/trading/DragHandle";

const base = (): ChartState => ({
    indicators: allIndicators(false),
    settings: { ...DEFAULT_INDICATOR_SETTINGS, movingAverages: [] },
    vpvrMode: "visible",
    paneOrder: [...PANE_IDS],
    paneCollapsed: Object.fromEntries(PANE_IDS.map((p) => [p, true])) as ChartState["paneCollapsed"],
    paneHeights: { ...DEFAULT_HEIGHTS, cotReport: 120 } as ChartState["paneHeights"],
    timeframe: "1h",
});

describe("chart layout catalog", () => {
    it("is byte-identical to the API copy", () => {
        // Raw sources via Vite globs (the web tsconfig has no Node types).
        const web = Object.values(import.meta.glob("../catalog.ts", { query: "?raw", import: "default", eager: true }));
        const api = Object.values(import.meta.glob("../../../../../api/src/chartLayouts/catalog.ts", { query: "?raw", import: "default", eager: true }));
        expect(web).toHaveLength(1);
        expect(api).toHaveLength(1);
        expect(web[0]).toBe(api[0]);
    });

    it("lists exactly the indicators the toolbar toggles", () => {
        expect([...CHART_LAYOUT_CATALOG.indicators].sort()).toEqual(Object.keys(DEFAULT_INDICATOR_CONFIG).sort());
    });

    it("lists exactly the sub-panes the chart renders (DragHandle defaults + COT)", () => {
        expect([...CHART_LAYOUT_CATALOG.panes].sort()).toEqual([...Object.keys(DEFAULT_HEIGHTS), "cotReport"].sort());
    });
});

describe("presets", () => {
    const get = (name: string) => resolveConfig(PRESETS.find((p) => p.name === name)!.config, base());

    it("Swing: EMA 20/50/200 (crossing 50/200), PDH/PDL, VPVR (POC+VAH/VAL), RSI 14, ATR 14, Volume — all else off", () => {
        const s = get("Swing");
        const on = Object.entries(s.indicators).filter(([, v]) => v).map(([k]) => k).sort();
        expect(on).toEqual(["atr", "keyLevels", "rsi", "volume", "vpvr"]);
        expect(s.settings).toEqual(LEGACY_SETTINGS);
        expect(s.vpvrMode).toBe("visible");
        expect(s.paneOrder.slice(0, 3)).toEqual(["rsi", "atr", "volume"]);
        expect(s.paneCollapsed.rsi).toBe(false);
        expect(s.paneCollapsed.atr).toBe(false);
        expect(s.paneCollapsed.volume).toBe(false);
    });

    it("Everything: every indicator on, plus EMA 20/50/200", () => {
        expect(Object.values(get("Everything").indicators).every(Boolean)).toBe(true);
        expect(Object.keys(get("Everything").indicators)).toHaveLength(21);
        expect(get("Everything").settings).toEqual(LEGACY_SETTINGS);
    });

    it("Clean: candles only (no moving averages either)", () => {
        const cur = { ...base(), settings: LEGACY_SETTINGS };
        const s = resolveConfig(PRESETS.find((p) => p.name === "Clean")!.config, cur);
        expect(Object.values(s.indicators).some(Boolean)).toBe(false);
        expect(s.settings).toEqual({ ...DEFAULT_INDICATOR_SETTINGS, movingAverages: [], maCross: null });
    });

    it("presets don't touch the timeframe", () => {
        const cur = { ...base(), timeframe: "15m" as const };
        for (const p of PRESETS) expect(resolveConfig(p.config, cur).timeframe).toBe("15m");
    });
});

/** What the old EMA 20/50/200 toggles (all on) draw now. */
const LEGACY_SETTINGS: ChartState["settings"] = {
    ...DEFAULT_INDICATOR_SETTINGS,
    movingAverages: [
        { id: "ema20", type: "EMA", length: 20, color: "#3b82f6" },
        { id: "ema50", type: "EMA", length: 50, color: "#f59e0b" },
        { id: "ema200", type: "EMA", length: 200, color: "#ef4444" },
    ],
    maCross: { fast: "ema50", slow: "ema200" },
};

describe("moving averages in a layout", () => {
    it("an old layout's EMA toggles draw the same lines, colors and cross", () => {
        const s = resolveConfig({ version: 1, indicators: { ema20: true, ema50: true, ema200: true, rsi: true } }, base());
        expect(s.settings).toEqual(LEGACY_SETTINGS);
        expect(Object.entries(s.indicators).filter(([, v]) => v).map(([k]) => k)).toEqual(["rsi"]);
    });

    it("only the old toggles that were on, cross only with 50 AND 200", () => {
        const s = resolveConfig({ version: 1, indicators: { ema20: true, ema50: true, ema200: false } }, base());
        expect(s.settings.movingAverages.map((m) => m.id)).toEqual(["ema20", "ema50"]);
        expect(s.settings.maCross).toBeNull();
    });

    it("a layout without moving averages draws none", () => {
        const cur = { ...base(), settings: LEGACY_SETTINGS };
        expect(resolveConfig({ version: 1, indicators: { rsi: true } }, cur).settings).toEqual({ ...DEFAULT_INDICATOR_SETTINGS, movingAverages: [], maCross: null });
    });

    it("drops bad lines, repeated ids and a cross on a missing line; clamps lengths", () => {
        const s = resolveConfig({
            version: 1,
            params: {
                movingAverages: [
                    { id: "a", type: "SMA", length: 9999, color: "#112233" },
                    { id: "a", type: "EMA", length: 20, color: "#112233" },
                    { id: "b", type: "WMA", length: 20, color: "#112233" },
                    { id: "c", type: "EMA", length: 0.4, color: "#112233" },
                    { id: "d", type: "EMA", length: 20, color: "blue" },
                    "junk",
                ],
                maCross: { fast: "a", slow: "b" },
            },
        }, base());
        expect(s.settings.movingAverages).toEqual([
            { id: "a", type: "SMA", length: 500, color: "#112233" },
            { id: "c", type: "EMA", length: 1, color: "#112233" },
        ]);
        expect(s.settings.maCross).toBeNull();
    });

    it("caps the list at the catalog max", () => {
        const many = Array.from({ length: 14 }, (_, i) => ({ id: `m${i}`, type: "EMA", length: i + 1, color: "#112233" }));
        expect(resolveConfig({ version: 1, params: { movingAverages: many } }, base()).settings.movingAverages)
            .toHaveLength(CHART_LAYOUT_CATALOG.movingAverages.maxLines);
    });
});

describe("ADX / UT Bot settings in a layout", () => {
    it("default to TradingView's (ADX 14/14, line at 25; UT Bot 1 / ATR 10)", () => {
        expect(DEFAULT_INDICATOR_SETTINGS.adx).toEqual({ diLength: 14, adxSmoothing: 14, threshold: 25 });
        expect(DEFAULT_INDICATOR_SETTINGS.utBot).toEqual({ keyValue: 1, atrPeriod: 10 });
    });

    it("a layout without them (saved before) gets the defaults", () => {
        const cur = { ...base(), settings: { ...base().settings, adx: { diLength: 5, adxSmoothing: 5, threshold: 40 } } };
        expect(resolveConfig({ version: 1, indicators: { adx: true } }, cur).settings.adx).toEqual(DEFAULT_INDICATOR_SETTINGS.adx);
    });

    it("clamps to the catalog range and grid; bad values fall back per key", () => {
        const s = resolveConfig({
            version: 1,
            params: { adx: { diLength: 0, adxSmoothing: 999, threshold: "x" }, utBot: { keyValue: 1.26, atrPeriod: 7.6 } },
        }, base()).settings;
        expect(s.adx).toEqual({ diLength: 1, adxSmoothing: 200, threshold: 25 });
        expect(s.utBot).toEqual({ keyValue: 1.3, atrPeriod: 8 });
    });

    it("editing one marks the layout modified", () => {
        const s = base();
        const cfg = captureConfig(s);
        expect(isModified(cfg, { ...s, settings: { ...s.settings, adx: { ...s.settings.adx, threshold: 20 } } })).toBe(true);
        expect(isModified(cfg, { ...s, settings: { ...s.settings, utBot: { ...s.settings.utBot, keyValue: 2 } } })).toBe(true);
    });

    it("the ADX pane is a layout pane", () => {
        expect(PANE_IDS).toContain("adx");
    });
});

describe("resolveConfig (forward-compatible reader)", () => {
    it("skips an indicator this build doesn't know, silently", () => {
        const s = resolveConfig({ version: 1, indicators: { rsi: true, stochRsi: true, ema21: true } }, base());
        expect(s.indicators.rsi).toBe(true);
        expect(Object.keys(s.indicators)).toHaveLength(21);
        expect("stochRsi" in s.indicators).toBe(false);
    });

    it("turns off indicators an old layout doesn't mention", () => {
        const cur = { ...base(), indicators: allIndicators(true) };
        const s = resolveConfig({ version: 1, indicators: { rsi: true } }, cur);
        expect(Object.entries(s.indicators).filter(([, v]) => v).map(([k]) => k)).toEqual(["rsi"]);
    });

    it("skips unknown/duplicate panes in order and appends missing ones in default order", () => {
        const s = resolveConfig({ version: 1, panes: { order: ["atr", "stoch", "atr", "rsi"] } }, base());
        expect(s.paneOrder).toEqual(["atr", "rsi", "volume", "macd", "delta", "cvd", "fundingRate", "openInterest", "cotReport", "adx"]);
    });

    it("clamps heights and ignores unknown panes / bad values", () => {
        const s = resolveConfig({ version: 1, panes: { heights: { rsi: 9999, atr: 1, stoch: 100, macd: "big" } } }, base());
        expect(s.paneHeights.rsi).toBe(400);
        expect(s.paneHeights.atr).toBe(40);
        expect(s.paneHeights.macd).toBe(base().paneHeights.macd);
    });

    it("keeps the current timeframe / VPVR mode when the config's are unknown", () => {
        const s = resolveConfig({ version: 1, timeframe: "2h", params: { vpvr: { mode: "monthly" } } }, { ...base(), timeframe: "4h", vpvrMode: "daily" });
        expect(s.timeframe).toBe("4h");
        expect(s.vpvrMode).toBe("daily");
    });

    it("never throws on garbage", () => {
        for (const junk of [null, undefined, 42, "x", [], { indicators: [] }, { panes: { order: "rsi" } }, { version: 9, foo: { bar: 1 } }]) {
            expect(() => resolveConfig(junk, base())).not.toThrow();
        }
    });
});

describe("captureConfig + isModified", () => {
    it("capture → resolve round-trips the whole state", () => {
        const s: ChartState = {
            ...base(),
            indicators: { ...allIndicators(false), rsi: true, vpvr: true },
            settings: {
                ...DEFAULT_INDICATOR_SETTINGS,
                adx: { diLength: 10, adxSmoothing: 20, threshold: 30 },
                utBot: { keyValue: 2.5, atrPeriod: 14 },
                movingAverages: [
                    { id: "ma1", type: "SMA", length: 20, color: "#3b82f6" },
                    { id: "ma2", type: "EMA", length: 200, color: "#ef4444" },
                ],
                maCross: { fast: "ma1", slow: "ma2" },
            },
            vpvrMode: "weekly",
            paneOrder: ["cvd", ...PANE_IDS.filter((p) => p !== "cvd")],
            paneCollapsed: { ...base().paneCollapsed, rsi: false },
            paneHeights: { ...base().paneHeights, rsi: 150 },
            timeframe: "4h",
        };
        const cfg = captureConfig(s);
        expect(resolveConfig(cfg, base())).toEqual(s);
        expect(isModified(cfg, s)).toBe(false);
        expect(JSON.stringify(cfg).length).toBeLessThan(CHART_LAYOUT_CATALOG.maxConfigBytes);
    });

    it("captures only catalog values (what the API accepts)", () => {
        const cfg = captureConfig(base());
        expect(Object.keys(cfg).sort()).toEqual(["indicators", "panes", "params", "timeframe", "version"]);
        expect(cfg.params).toEqual({
            vpvr: { mode: "visible" }, rsi: { period: 14 }, atr: { period: 14 },
            macd: { fast: 12, slow: 26, signal: 9 }, bollingerBands: { period: 20, stdDev: 2 },
            movingAverages: [],
            adx: { diLength: 14, adxSmoothing: 14, threshold: 25 },
            utBot: { keyValue: 1, atrPeriod: 10 },
        });
    });

    it("flags any change the layout owns", () => {
        const s = base();
        const cfg = captureConfig(s);
        expect(isModified(cfg, { ...s, indicators: { ...s.indicators, macd: true } })).toBe(true);
        expect(isModified(cfg, { ...s, timeframe: "5m" })).toBe(true);
        expect(isModified(cfg, { ...s, paneHeights: { ...s.paneHeights, rsi: 81 } })).toBe(true);
        expect(isModified(cfg, { ...s, paneCollapsed: { ...s.paneCollapsed, rsi: false } })).toBe(true);
        expect(isModified(cfg, { ...s, paneOrder: [...s.paneOrder].reverse() })).toBe(true);
        const line = { id: "ma1", type: "SMA" as const, length: 20, color: "#3b82f6" };
        const withLine = { ...s, settings: { ...DEFAULT_INDICATOR_SETTINGS, movingAverages: [line], maCross: null } };
        const lineCfg = captureConfig(withLine);
        expect(isModified(cfg, withLine)).toBe(true);
        expect(isModified(lineCfg, withLine)).toBe(false);
        expect(isModified(lineCfg, { ...s, settings: { ...DEFAULT_INDICATOR_SETTINGS, movingAverages: [{ ...line, length: 21 }], maCross: null } })).toBe(true);
        expect(isModified(lineCfg, { ...s, settings: { ...DEFAULT_INDICATOR_SETTINGS, movingAverages: [{ ...line, color: "#ffffff" }], maCross: null } })).toBe(true);
    });

    it("ignores fields a preset doesn't name (timeframe, heights)", () => {
        const swing = PRESETS[0]!.config;
        const applied = resolveConfig(swing, base());
        expect(isModified(swing, { ...applied, timeframe: "1d", paneHeights: { ...applied.paneHeights, rsi: 200 } })).toBe(false);
        expect(isModified(swing, { ...applied, indicators: { ...applied.indicators, cvd: true } })).toBe(true);
    });
});
