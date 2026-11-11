import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/api/endpoints/chartLayouts", () => ({
    listChartLayouts: vi.fn(),
    createChartLayout: vi.fn(),
    updateChartLayout: vi.fn(),
    deleteChartLayout: vi.fn(),
}));

import * as api from "@/api/endpoints/chartLayouts";
import type { SavedChartLayout } from "@/api/endpoints/chartLayouts";
import { useChartLayoutStore, currentChartState } from "@/stores/chartLayoutStore";
import { useTradingStore, DEFAULT_INDICATOR_CONFIG } from "@/stores/tradingStore";
import { useIndicatorSettingsStore } from "@/stores/indicatorSettingsStore";
import { DEFAULT_INDICATOR_SETTINGS } from "@/lib/chartLayouts/layoutConfig";
import { DEFAULT_HEIGHTS } from "@/components/trading/DragHandle";
import { PANE_IDS, captureConfig, isModified } from "@/lib/chartLayouts/layoutConfig";

const mocked = vi.mocked(api);

function layout(over: Partial<SavedChartLayout> = {}): SavedChartLayout {
    return {
        id: "11111111-1111-1111-1111-111111111111",
        name: "Mine",
        config: { version: 1, indicators: { rsi: true } },
        is_default: false,
        created_at: "2026-11-02T00:00:00Z",
        updated_at: "2026-11-02T00:00:00Z",
        ...over,
    };
}
const ok = <T,>(data: T) => Promise.resolve({ data }) as never;

function on() {
    return Object.entries(useTradingStore.getState().indicatorConfig).filter(([, v]) => v).map(([k]) => k).sort();
}

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useTradingStore.setState({ indicatorConfig: { ...DEFAULT_INDICATOR_CONFIG } });
    useIndicatorSettingsStore.setState({ ...DEFAULT_INDICATOR_SETTINGS });
    useChartLayoutStore.getState().resetSession();
    useChartLayoutStore.setState({ layouts: [] });
});

describe("no saved layouts, no default → today's chart, untouched", () => {
    it("starts at today's values", () => {
        const s = useChartLayoutStore.getState();
        expect(s.timeframe).toBe("1h");
        expect(s.vpvrMode).toBe("visible");
        expect(s.paneOrder).toEqual(["volume", "macd", "rsi", "atr", "delta", "cvd", "fundingRate", "openInterest", "cotReport", "adx"]);
        expect(Object.values(s.paneCollapsed).every(Boolean)).toBe(true);
        expect(s.paneHeights).toEqual({ ...DEFAULT_HEIGHTS, cotReport: 120 });
        expect(s.activeLayoutId).toBeNull();
    });

    it("loading an empty list changes nothing and writes nothing", async () => {
        localStorage.setItem("indicator-config-version", "10");
        localStorage.setItem("indicator-config", JSON.stringify({ ...DEFAULT_INDICATOR_CONFIG, macd: true }));
        useTradingStore.setState({ indicatorConfig: { ...DEFAULT_INDICATOR_CONFIG, macd: true } });
        const before = { trading: useTradingStore.getState().indicatorConfig, chart: currentChartState() };
        const storage = JSON.stringify({ ...localStorage });

        mocked.listChartLayouts.mockReturnValue(ok({ layouts: [] }));
        await useChartLayoutStore.getState().loadLayouts();

        expect(useTradingStore.getState().indicatorConfig).toBe(before.trading); // same object: never set
        expect(currentChartState()).toEqual(before.chart);
        expect(JSON.stringify({ ...localStorage })).toBe(storage);
        expect(useChartLayoutStore.getState().activeLayoutId).toBeNull();
    });

    it("a failed list leaves the chart alone", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        mocked.listChartLayouts.mockImplementation(() => Promise.reject(new Error("offline")) as never);
        const before = currentChartState();
        await useChartLayoutStore.getState().loadLayouts();
        expect(currentChartState()).toEqual(before);
    });
});

describe("default on load", () => {
    it("applies the default layout once", async () => {
        const def = layout({
            id: "22222222-2222-2222-2222-222222222222",
            name: "Def",
            is_default: true,
            config: { version: 1, indicators: { macd: true, cvd: true }, timeframe: "4h", panes: { collapsed: { macd: false } } },
        });
        mocked.listChartLayouts.mockReturnValue(ok({ layouts: [layout(), def] }));
        await useChartLayoutStore.getState().loadLayouts();

        expect(on()).toEqual(["cvd", "macd"]);
        expect(useChartLayoutStore.getState().timeframe).toBe("4h");
        expect(useChartLayoutStore.getState().paneCollapsed.macd).toBe(false);
        expect(useChartLayoutStore.getState().activeLayoutId).toBe(def.id);

        // A second fetch (menu remount) must not re-apply over the user's changes.
        useTradingStore.getState().toggleIndicator("rsi");
        await useChartLayoutStore.getState().loadLayouts();
        expect(on()).toEqual(["cvd", "macd", "rsi"]);
    });

    it("re-applies on the next visit to /trade (after resetSession)", async () => {
        const def = layout({ is_default: true, config: { version: 1, indicators: { atr: true } } });
        mocked.listChartLayouts.mockReturnValue(ok({ layouts: [def] }));
        await useChartLayoutStore.getState().loadLayouts();
        useTradingStore.getState().toggleIndicator("atr");
        useChartLayoutStore.getState().resetSession();
        await useChartLayoutStore.getState().loadLayouts();
        expect(on()).toEqual(["atr"]);
    });

    it("skips an indicator that no longer exists, silently", async () => {
        const def = layout({ is_default: true, config: { version: 1, indicators: { rsi: true, stochRsi: true } } as never });
        mocked.listChartLayouts.mockReturnValue(ok({ layouts: [def] }));
        await useChartLayoutStore.getState().loadLayouts();
        expect(on()).toEqual(["rsi"]);
        expect("stochRsi" in useTradingStore.getState().indicatorConfig).toBe(false);
    });
});

describe("presets", () => {
    it("applies Swing instantly", () => {
        useChartLayoutStore.getState().applyLayout("preset:swing");
        expect(on()).toEqual(["atr", "keyLevels", "rsi", "volume", "vpvr"]);
        const ma = useIndicatorSettingsStore.getState();
        expect(ma.movingAverages.map((m) => `${m.type} ${m.length}`)).toEqual(["EMA 20", "EMA 50", "EMA 200"]);
        expect(ma.maCross).toEqual({ fast: "ema50", slow: "ema200" });
        expect(JSON.parse(localStorage.getItem("indicator-settings")!).movingAverages).toHaveLength(3);
        const s = useChartLayoutStore.getState();
        expect(s.paneOrder.slice(0, 3)).toEqual(["rsi", "atr", "volume"]);
        expect(s.activeLayoutId).toBe("preset:swing");
        // Persisted like a manual toggle (today's localStorage behavior).
        expect(JSON.parse(localStorage.getItem("indicator-config")!).vpvr).toBe(true);
    });

    it("Everything then Clean", () => {
        useChartLayoutStore.getState().applyLayout("preset:everything");
        expect(on()).toHaveLength(21);
        useChartLayoutStore.getState().applyLayout("preset:clean");
        expect(on()).toEqual([]);
        expect(useIndicatorSettingsStore.getState().movingAverages).toEqual([]);
    });
});

describe("moving averages", () => {
    it("a saved layout from before the list applies its EMA toggles as the same lines", async () => {
        const def = layout({ is_default: true, config: { version: 1, indicators: { ema50: true, ema200: true } } as never });
        mocked.listChartLayouts.mockReturnValue(ok({ layouts: [def] }));
        await useChartLayoutStore.getState().loadLayouts();
        const s = useIndicatorSettingsStore.getState();
        expect(s.movingAverages).toEqual([
            { id: "ema50", type: "EMA", length: 50, color: "#f59e0b" },
            { id: "ema200", type: "EMA", length: 200, color: "#ef4444" },
        ]);
        expect(s.maCross).toEqual({ fast: "ema50", slow: "ema200" });
        expect(isModified(def.config, currentChartState())).toBe(false);
    });

    it("are saved with the layout, and editing one marks the layout modified", async () => {
        useIndicatorSettingsStore.getState().addMovingAverage();
        useIndicatorSettingsStore.getState().addMovingAverage();
        useIndicatorSettingsStore.getState().updateMovingAverage("ma1", { type: "SMA" });
        useIndicatorSettingsStore.getState().setMaCross({ fast: "ma1", slow: "ma2" });
        mocked.createChartLayout.mockImplementation((body) => ok({ layout: layout({ name: body.name, config: body.config }) }));

        await useChartLayoutStore.getState().saveAs("MAs");
        const cfg = mocked.createChartLayout.mock.calls[0]![0].config;
        expect(cfg.params?.movingAverages).toEqual([
            { id: "ma1", type: "SMA", length: 20, color: "#3b82f6" },
            { id: "ma2", type: "EMA", length: 50, color: "#f59e0b" },
        ]);
        expect(cfg.params?.maCross).toEqual({ fast: "ma1", slow: "ma2" });
        expect(isModified(cfg, currentChartState())).toBe(false);

        useIndicatorSettingsStore.getState().updateMovingAverage("ma2", { length: 100 });
        expect(isModified(cfg, currentChartState())).toBe(true);
        useChartLayoutStore.getState().applyLayout(useChartLayoutStore.getState().activeLayoutId!);
        expect(useIndicatorSettingsStore.getState().movingAverages[1]!.length).toBe(50);
    });
});

describe("save / update / rename / delete / default", () => {
    it("saves the current chart and makes it active", async () => {
        useTradingStore.getState().toggleIndicator("rsi");
        useChartLayoutStore.getState().setTimeframe("15m");
        mocked.createChartLayout.mockImplementation((body) => ok({ layout: layout({ name: body.name, config: body.config, is_default: !!body.isDefault }) }));

        await useChartLayoutStore.getState().saveAs("Scalp", { isDefault: true });

        const body = mocked.createChartLayout.mock.calls[0]![0];
        expect(body.name).toBe("Scalp");
        expect(body.isDefault).toBe(true);
        expect(body.config).toEqual(captureConfig(currentChartState()));
        expect(body.config.timeframe).toBe("15m");
        expect(useChartLayoutStore.getState().layouts.map((l) => l.name)).toEqual(["Scalp"]);
        expect(useChartLayoutStore.getState().activeLayoutId).toBe(layout().id);
    });

    it("a new default clears the old one locally", async () => {
        useChartLayoutStore.setState({ layouts: [layout({ id: "a", is_default: true })] });
        mocked.createChartLayout.mockReturnValue(ok({ layout: layout({ id: "b", name: "B", is_default: true }) }));
        await useChartLayoutStore.getState().saveAs("B", { isDefault: true });
        expect(useChartLayoutStore.getState().layouts.map((l) => [l.id, l.is_default])).toEqual([["a", false], ["b", true]]);
    });

    it("surfaces the server's message on failure", async () => {
        mocked.createChartLayout.mockImplementation(() =>
            Promise.reject({ response: { data: { message: "You already have a chart layout with this name." } } }) as never,
        );
        await expect(useChartLayoutStore.getState().saveAs("Dup")).rejects.toThrow("already have a chart layout");
    });

    it("updates the active layout with the current chart", async () => {
        const l = layout();
        useChartLayoutStore.setState({ layouts: [l] });
        useChartLayoutStore.getState().applyLayout(l.id);
        useTradingStore.getState().toggleIndicator("macd");
        mocked.updateChartLayout.mockImplementation((id, patch) => ok({ layout: { ...l, id, config: patch.config! } }));

        await useChartLayoutStore.getState().updateActive();

        expect(mocked.updateChartLayout).toHaveBeenCalledWith(l.id, { config: captureConfig(currentChartState()) });
        const saved = useChartLayoutStore.getState().layouts[0]!;
        expect(isModified(saved.config, currentChartState())).toBe(false);
    });

    it("never updates a preset", async () => {
        useChartLayoutStore.getState().applyLayout("preset:swing");
        await useChartLayoutStore.getState().updateActive();
        expect(mocked.updateChartLayout).not.toHaveBeenCalled();
    });

    it("renames, sets default (clearing others) and deletes", async () => {
        const a = layout({ id: "a", name: "A", is_default: true });
        const b = layout({ id: "b", name: "B" });
        useChartLayoutStore.setState({ layouts: [a, b], activeLayoutId: "b" });

        mocked.updateChartLayout.mockReturnValueOnce(ok({ layout: { ...b, name: "B2" } }));
        await useChartLayoutStore.getState().renameLayout("b", "B2");
        expect(mocked.updateChartLayout).toHaveBeenLastCalledWith("b", { name: "B2" });

        mocked.updateChartLayout.mockReturnValueOnce(ok({ layout: { ...b, name: "B2", is_default: true } }));
        await useChartLayoutStore.getState().setDefault("b", true);
        expect(useChartLayoutStore.getState().layouts.map((l) => [l.name, l.is_default])).toEqual([["A", false], ["B2", true]]);

        mocked.deleteChartLayout.mockReturnValue(ok(undefined));
        const chartBefore = currentChartState();
        await useChartLayoutStore.getState().deleteLayout("b");
        expect(useChartLayoutStore.getState().layouts.map((l) => l.id)).toEqual(["a"]);
        expect(useChartLayoutStore.getState().activeLayoutId).toBeNull();
        expect(currentChartState()).toEqual(chartBefore); // deleting doesn't change the chart
    });
});

describe("pane state", () => {
    it("turning a pane's indicator off collapses it again (as unmounting did)", () => {
        useTradingStore.getState().toggleIndicator("rsi");
        useChartLayoutStore.getState().togglePaneCollapsed("rsi");
        expect(useChartLayoutStore.getState().paneCollapsed.rsi).toBe(false);
        useTradingStore.getState().toggleIndicator("rsi");
        expect(useChartLayoutStore.getState().paneCollapsed.rsi).toBe(true);
    });

    it("moving a pane jumps over hidden ones", () => {
        const visible = ["volume", "rsi", "cotReport"] as const;
        useChartLayoutStore.getState().movePane("cotReport", -1, [...visible]);
        let o = useChartLayoutStore.getState().paneOrder;
        expect(o.filter((p) => (visible as readonly string[]).includes(p))).toEqual(["volume", "cotReport", "rsi"]);
        useChartLayoutStore.getState().movePane("volume", 1, [...visible]);
        o = useChartLayoutStore.getState().paneOrder;
        expect(o.filter((p) => (visible as readonly string[]).includes(p))).toEqual(["cotReport", "volume", "rsi"]);
        expect([...o].sort()).toEqual([...PANE_IDS].sort());
        // No-op at the ends.
        useChartLayoutStore.getState().movePane("cotReport", -1, [...visible]);
        expect(useChartLayoutStore.getState().paneOrder).toEqual(o);
    });

    it("drag heights persist on drag end only", () => {
        useChartLayoutStore.getState().setPaneHeight("rsi", 150);
        expect(localStorage.getItem("tradr_panel_heights")).toBeNull();
        useChartLayoutStore.getState().commitPaneHeight("rsi", 160);
        expect(JSON.parse(localStorage.getItem("tradr_panel_heights")!).rsi).toBe(160);
    });
});
