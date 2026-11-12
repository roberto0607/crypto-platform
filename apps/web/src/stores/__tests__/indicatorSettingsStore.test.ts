import { describe, it, expect, beforeEach } from "vitest";
import {
    INDICATOR_SETTINGS_KEY,
    loadIndicatorSettings,
    nextMovingAverage,
    useIndicatorSettingsStore,
} from "@/stores/indicatorSettingsStore";
import { DEFAULT_INDICATOR_SETTINGS } from "@/lib/chartLayouts/layoutConfig";

const store = () => useIndicatorSettingsStore.getState();

beforeEach(() => {
    localStorage.clear();
    useIndicatorSettingsStore.setState({ ...DEFAULT_INDICATOR_SETTINGS });
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
            ...DEFAULT_INDICATOR_SETTINGS,
            movingAverages: [{ id: "ema200", type: "EMA", length: 200, color: "#ef4444" }],
            maCross: null,
        });
    });

    it("nothing stored → no lines", () => {
        expect(loadIndicatorSettings()).toEqual({ ...DEFAULT_INDICATOR_SETTINGS, movingAverages: [], maCross: null });
    });

    it("saved settings win over old toggles; garbage → no lines", () => {
        localStorage.setItem("indicator-config", JSON.stringify({ ema20: true }));
        localStorage.setItem(INDICATOR_SETTINGS_KEY, JSON.stringify({ movingAverages: [] }));
        expect(loadIndicatorSettings().movingAverages).toEqual([]);
        localStorage.setItem(INDICATOR_SETTINGS_KEY, "{not json");
        expect(loadIndicatorSettings()).toEqual({ ...DEFAULT_INDICATOR_SETTINGS, movingAverages: [], maCross: null });
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

describe("ADX / UT Bot settings", () => {
    it("settings saved before ADX/UT Bot existed load with the defaults", () => {
        localStorage.setItem(INDICATOR_SETTINGS_KEY, JSON.stringify({ movingAverages: [], maCross: null }));
        const s = loadIndicatorSettings();
        expect(s.adx).toEqual({ diLength: 14, adxSmoothing: 14, threshold: 25 });
        expect(s.utBot).toEqual({ keyValue: 1, atrPeriod: 10 });
    });

    it("edits one field at a time, clamped, and persists (survives reload)", () => {
        store().setAdx({ threshold: 20 });
        store().setAdx({ diLength: 500 });
        store().setUtBot({ keyValue: 2.04 });
        store().setUtBot({ atrPeriod: 14 });
        expect(store().adx).toEqual({ diLength: 200, adxSmoothing: 14, threshold: 20 });
        expect(store().utBot).toEqual({ keyValue: 2, atrPeriod: 14 });
        expect(loadIndicatorSettings()).toMatchObject({ adx: store().adx, utBot: store().utBot });
    });
});

describe("support/resistance settings", () => {
    it("settings saved before S/R existed load with the defaults", () => {
        localStorage.setItem(INDICATOR_SETTINGS_KEY, JSON.stringify({ movingAverages: [], maCross: null }));
        const s = loadIndicatorSettings();
        expect(s.supportResistance).toMatchObject({ left: 10, right: 10, nearest: 3 });
        expect(s.supportResistanceOptions).toEqual({ htf: "off", showBroken: "on", volumeFilter: "off", maxAge: "off" });
    });

    it("edits are clamped, persisted, and survive reload", () => {
        store().setSupportResistance({ left: 5 });
        store().setSupportResistance({ mergeAtr: 0.42 });
        store().setSupportResistanceOptions({ htf: "1d", maxAge: "on" });
        expect(store().supportResistance).toMatchObject({ left: 5, right: 10, mergeAtr: 0.4 });
        expect(store().supportResistanceOptions).toEqual({ htf: "1d", showBroken: "on", volumeFilter: "off", maxAge: "on" });
        expect(loadIndicatorSettings()).toMatchObject({
            supportResistance: store().supportResistance,
            supportResistanceOptions: store().supportResistanceOptions,
        });
    });
});
