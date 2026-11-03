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
import { DEFAULT_HEIGHTS } from "@/components/trading/DragHandle";

const base = (): ChartState => ({
    indicators: allIndicators(false),
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

    it("Swing: EMA 20/50/200, PDH/PDL, VPVR (POC+VAH/VAL), RSI 14, ATR 14, Volume — all else off", () => {
        const s = get("Swing");
        const on = Object.entries(s.indicators).filter(([, v]) => v).map(([k]) => k).sort();
        expect(on).toEqual(["atr", "ema20", "ema200", "ema50", "keyLevels", "rsi", "volume", "vpvr"]);
        expect(s.vpvrMode).toBe("visible");
        expect(s.paneOrder.slice(0, 3)).toEqual(["rsi", "atr", "volume"]);
        expect(s.paneCollapsed.rsi).toBe(false);
        expect(s.paneCollapsed.atr).toBe(false);
        expect(s.paneCollapsed.volume).toBe(false);
    });

    it("Everything: every indicator on", () => {
        expect(Object.values(get("Everything").indicators).every(Boolean)).toBe(true);
        expect(Object.keys(get("Everything").indicators)).toHaveLength(21);
    });

    it("Clean: candles only", () => {
        expect(Object.values(get("Clean").indicators).some(Boolean)).toBe(false);
    });

    it("presets don't touch the timeframe", () => {
        const cur = { ...base(), timeframe: "15m" as const };
        for (const p of PRESETS) expect(resolveConfig(p.config, cur).timeframe).toBe("15m");
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
        expect(s.paneOrder).toEqual(["atr", "rsi", "volume", "macd", "delta", "cvd", "fundingRate", "openInterest", "cotReport"]);
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
    });

    it("ignores fields a preset doesn't name (timeframe, heights)", () => {
        const swing = PRESETS[0]!.config;
        const applied = resolveConfig(swing, base());
        expect(isModified(swing, { ...applied, timeframe: "1d", paneHeights: { ...applied.paneHeights, rsi: 200 } })).toBe(false);
        expect(isModified(swing, { ...applied, indicators: { ...applied.indicators, cvd: true } })).toBe(true);
    });
});
