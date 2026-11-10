import { describe, it, expect, beforeEach } from "vitest";
import {
    INDICATOR_SETTINGS_KEY,
    loadIndicatorSettings,
    nextMovingAverage,
    useIndicatorSettingsStore,
} from "@/stores/indicatorSettingsStore";

const store = () => useIndicatorSettingsStore.getState();

beforeEach(() => {
    localStorage.clear();
    useIndicatorSettingsStore.setState({ movingAverages: [], maCross: null });
});

describe("first load after the list shipped (no saved settings)", () => {
    it("turns the old EMA 20/50/200 toggles into the same lines, with the 50/200 cross, and saves that", () => {
        localStorage.setItem("indicator-config", JSON.stringify({ ema20: true, ema50: true, ema200: true, rsi: true }));
        const s = loadIndicatorSettings();
        expect(s.movingAverages).toEqual([
            { id: "ema20", type: "EMA", length: 20, color: "#3b82f6" },
            { id: "ema50", type: "EMA", length: 50, color: "#f59e0b" },
            { id: "ema200", type: "EMA", length: 200, color: "#ef4444" },
        ]);
        expect(s.maCross).toEqual({ fast: "ema50", slow: "ema200" });
        expect(JSON.parse(localStorage.getItem(INDICATOR_SETTINGS_KEY)!)).toEqual(s);
    });

    it("only the toggles that were on; no cross unless 50 and 200 both were", () => {
        localStorage.setItem("indicator-config", JSON.stringify({ ema20: false, ema50: false, ema200: true }));
        expect(loadIndicatorSettings()).toEqual({
            movingAverages: [{ id: "ema200", type: "EMA", length: 200, color: "#ef4444" }],
            maCross: null,
        });
    });

    it("nothing stored → no lines", () => {
        expect(loadIndicatorSettings()).toEqual({ movingAverages: [], maCross: null });
    });

    it("saved settings win over old toggles; garbage → no lines", () => {
        localStorage.setItem("indicator-config", JSON.stringify({ ema20: true }));
        localStorage.setItem(INDICATOR_SETTINGS_KEY, JSON.stringify({ movingAverages: [] }));
        expect(loadIndicatorSettings().movingAverages).toEqual([]);
        localStorage.setItem(INDICATOR_SETTINGS_KEY, "{not json");
        expect(loadIndicatorSettings()).toEqual({ movingAverages: [], maCross: null });
    });
});

describe("editing", () => {
    it("adds lines with the next unused length/color/id, up to 10", () => {
        for (let i = 0; i < 12; i++) store().addMovingAverage();
        const lines = store().movingAverages;
        expect(lines).toHaveLength(10);
        expect(lines.slice(0, 3).map((m) => [m.id, m.type, m.length, m.color])).toEqual([
            ["ma1", "EMA", 20, "#3b82f6"],
            ["ma2", "EMA", 50, "#f59e0b"],
            ["ma3", "EMA", 200, "#ef4444"],
        ]);
        expect(new Set(lines.map((m) => m.id)).size).toBe(10);
    });

    it("reuses a freed id", () => {
        expect(nextMovingAverage([{ id: "ma2", type: "SMA", length: 20, color: "#3b82f6" }]).id).toBe("ma1");
    });

    it("updates type/length/color, clamping the length, and persists", () => {
        store().addMovingAverage();
        store().updateMovingAverage("ma1", { type: "SMA", length: 9000, color: "#22c55e" });
        expect(store().movingAverages).toEqual([{ id: "ma1", type: "SMA", length: 500, color: "#22c55e" }]);
        expect(JSON.parse(localStorage.getItem(INDICATOR_SETTINGS_KEY)!).movingAverages[0].length).toBe(500);
    });

    it("removing a line used by the cross removes the cross", () => {
        store().addMovingAverage();
        store().addMovingAverage();
        store().addMovingAverage();
        store().setMaCross({ fast: "ma1", slow: "ma3" });
        store().removeMovingAverage("ma2");
        expect(store().maCross).toEqual({ fast: "ma1", slow: "ma3" });
        store().removeMovingAverage("ma3");
        expect(store().maCross).toBeNull();
    });

    it("refuses a cross on one line or on a missing one", () => {
        store().addMovingAverage();
        store().setMaCross({ fast: "ma1", slow: "ma1" });
        expect(store().maCross).toBeNull();
        store().setMaCross({ fast: "ma1", slow: "zz" });
        expect(store().maCross).toBeNull();
    });
});
