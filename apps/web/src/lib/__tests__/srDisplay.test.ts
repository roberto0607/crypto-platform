import { describe, it, expect } from "vitest";
import {
    buildSRDrawables,
    formatConfirmDelay,
    srApproach,
    srBreakMarkers,
    srBrokeAt,
    srChartState,
    srComputeOpts,
    srConfirmText,
    srLabel,
    srLabelled,
    srParamsForTimeframe,
    SR_COLORS,
} from "../srDisplay";
import { computeSupportResistance, type SRLevel } from "../sharedIndicators";
import { DEFAULT_INDICATOR_SETTINGS } from "../chartLayouts/layoutConfig";

const P = DEFAULT_INDICATOR_SETTINGS.supportResistance;
const O = DEFAULT_INDICATOR_SETTINGS.supportResistanceOptions;

let seq = 0;
function lv(o: Partial<SRLevel> & { price: number }): SRLevel {
    const i = seq++;
    return {
        id: `H${i}`, role: "resistance", origin: "swingHigh", flippedFrom: null,
        top: o.price, bottom: o.price,
        touches: [{ index: i, time: i, confirmedIndex: i + 10, confirmedTime: i + 10, price: o.price }],
        createdIndex: i, createdTime: i * 100, confirmedIndex: i + 10, confirmedTime: (i + 10) * 100,
        brokenIndex: null, brokenTime: null, ageBars: 5, staleIndex: null, staleTime: null,
        ...o,
    };
}

describe("srComputeOpts", () => {
    it("maps the saved settings to the shared math's params (switches off → filter/age off)", () => {
        expect(srComputeOpts(P, O)).toEqual({ left: 10, right: 10, mergeAtr: 0.5, breakAtr: 0.25, maxZoneAtr: 1.5, volumeFilter: false, volumeMult: 1.5, maxAge: 0 });
        expect(srComputeOpts(P, { ...O, volumeFilter: "on", maxAge: "on" })).toMatchObject({ volumeFilter: true, maxAge: 200 });
        expect(srComputeOpts({ ...P, htfLeft: 3, htfRight: 4 }, O, true)).toMatchObject({ left: 3, right: 4 });
    });
});

describe("srLabel", () => {
    it("role letter + touches; a flip shows where it came from; HTF tag first; stale flagged", () => {
        expect(srLabel(lv({ price: 1, touches: Array(3).fill(lv({ price: 1 }).touches[0]) }))).toBe("R ×3");
        expect(srLabel(lv({ price: 1, role: "support", origin: "swingLow" }))).toBe("S ×1");
        expect(srLabel(lv({ price: 1, role: "support", flippedFrom: "H1" }))).toBe("R→S ×1");
        expect(srLabel(lv({ price: 1, role: "resistance", origin: "swingLow", flippedFrom: "L1" }))).toBe("S→R ×1");
        expect(srLabel(lv({ price: 1 }), "1D")).toBe("1D R ×1");
        expect(srLabel(lv({ price: 1, staleIndex: 40 }))).toBe("R ×1 · old");
    });
});

describe("buildSRDrawables", () => {
    const above = [101, 102, 103, 104, 105].map((price) => lv({ price }));
    const below = [99, 98, 97, 96].map((price) => lv({ price, role: "support", origin: "swingLow" }));

    it("draws the nearest N above and N below price in full, the other active levels faded", () => {
        const d = buildSRDrawables({ levels: [...above, ...below], price: 100, nearest: 3, showBroken: true });
        const full = d.filter((x) => x.emphasis === "full").map((x) => x.price).sort((a, b) => a - b);
        expect(full).toEqual([97, 98, 99, 101, 102, 103]);
        expect(d.filter((x) => x.emphasis === "faded").map((x) => x.price).sort()).toEqual([104, 105, 96].sort());
        expect(d.find((x) => x.price === 101)).toMatchObject({ color: SR_COLORS.resistance, dashed: false, toTime: null, label: "R ×1" });
    });

    it("broken levels: faded, end at the break, hidden when history is off; stale levels faded", () => {
        const broken = lv({ price: 100.5, brokenIndex: 50, brokenTime: 5000 });
        const stale = lv({ price: 100.2, staleIndex: 30 });
        const d = buildSRDrawables({ levels: [broken, stale, ...above], price: 100, nearest: 3, showBroken: true });
        expect(d.find((x) => x.id === broken.id)).toMatchObject({ emphasis: "faded", toTime: 5000, broken: true });
        expect(d.find((x) => x.id === stale.id)).toMatchObject({ emphasis: "faded", label: "R ×1 · old" });
        // The stale one doesn't take a full slot: the three nearest fresh ones do.
        expect(d.filter((x) => x.emphasis === "full").map((x) => x.price)).toEqual([101, 102, 103]);
        expect(buildSRDrawables({ levels: [broken], price: 100, nearest: 3, showBroken: false })).toEqual([]);
    });

    it("keeps at most the 30 most recent broken levels", () => {
        const many = Array.from({ length: 40 }, (_, i) => lv({ price: 50 + i, brokenIndex: i, brokenTime: i * 10 }));
        const d = buildSRDrawables({ levels: many, price: 200, nearest: 3, showBroken: true });
        expect(d).toHaveLength(30);
        expect(Math.min(...d.map((x) => x.toTime!))).toBe(100);
    });

    it("HTF levels are dashed and tagged", () => {
        const d = buildSRDrawables({ levels: [lv({ price: 101 })], price: 100, nearest: 3, showBroken: true, tag: "1W" });
        expect(d[0]).toMatchObject({ dashed: true, label: "1W R ×1", id: `1W:${d[0]!.id.slice(3)}` });
    });

    it("a flipped level is drawn in its new role's color from the break bar", () => {
        const flip = lv({ price: 99, role: "support", flippedFrom: "H7", createdTime: 777 });
        expect(buildSRDrawables({ levels: [flip], price: 100, nearest: 3, showBroken: true })[0])
            .toMatchObject({ color: SR_COLORS.support, fromTime: 777, label: "R→S ×1" });
    });
});

describe("srApproach", () => {
    const r = lv({ price: 105, top: 105.4, bottom: 105 });
    const s = lv({ price: 95, role: "support", origin: "swingLow" });

    it("the nearest full level whose zone is within 0.5 × ATR of price", () => {
        const d = buildSRDrawables({ levels: [r, s], price: 104, nearest: 3, showBroken: true });
        expect(srApproach(d, 104, 4)).toMatchObject({ role: "resistance", price: 105, label: "R ×1" });
        expect(srApproach(d, 103, 4)).toMatchObject({ role: "resistance" }); // exactly 0.5 × 4 away
        expect(srApproach(d, 102.9, 4)).toBeNull(); // 2.1 away
    });

    it("price inside the zone counts; faded/broken levels never trigger", () => {
        const d = buildSRDrawables({ levels: [r, s], price: 105.2, nearest: 3, showBroken: true });
        expect(srApproach(d, 105.2, 1)).toMatchObject({ role: "resistance" });
        const faded = buildSRDrawables({ levels: [lv({ price: 100.1, brokenIndex: 3, brokenTime: 300 })], price: 100, nearest: 3, showBroken: true });
        expect(srApproach(faded, 100, 10)).toBeNull();
    });
});

describe("srBrokeAt / srBreakMarkers", () => {
    const levels = computeSupportResistance(
        [10, 10, 10, 11, 12, 11, 10, 10, 11, 12, 11, 10, 10, 11, 12, 13, 14, 15, 14, 13, 12].map((m, i) => ({
            time: i * 3600, open: m, high: m + 1, low: m - 1, close: m, volume: 100,
        })),
        { left: 2, right: 2, atrPeriod: 3 },
    );

    it("the level a bar broke (for the BROKE banner on that close), else null", () => {
        expect(srBrokeAt(levels, 16)).toMatchObject({ id: "H4", role: "resistance", price: 13 });
        expect(srBrokeAt(levels, 20)).toMatchObject({ id: "H4f", role: "support" });
        expect(srBrokeAt(levels, 17)).toBeNull();
    });

    it("one marker per break: up through resistance, down through support", () => {
        expect(srBreakMarkers(levels)).toEqual([
            { time: 16 * 3600, direction: "up" },
            { time: 20 * 3600, direction: "down" },
        ]);
    });
});

describe("confirmation delay text", () => {
    it("formats right × timeframe the way a trader says it", () => {
        expect(formatConfirmDelay(10 * 14_400)).toBe("40h");
        expect(formatConfirmDelay(10 * 86_400)).toBe("10d");
        expect(formatConfirmDelay(5 * 604_800)).toBe("5w");
        expect(formatConfirmDelay(10 * 900)).toBe("2.5h");
        expect(formatConfirmDelay(10 * 300)).toBe("50m");
        expect(formatConfirmDelay(10 * 3_600)).toBe("10h");
    });

    it("the settings-panel line for the chart timeframe and each HTF shown", () => {
        expect(srConfirmText(P, O, "4h")).toEqual(["confirms after 40h"]);
        expect(srConfirmText(P, { ...O, htf: "1d+1w" }, "4h")).toEqual(["confirms after 40h", "1D confirms after 5d", "1W confirms after 5w"]);
        // An HTF that isn't above the chart's timeframe isn't drawn, so not listed.
        expect(srConfirmText(P, { ...O, htf: "1d" }, "1d")).toEqual(["confirms after 10d"]);
    });
});

describe("srChartState (what the chart draws from its closed candles + HTF candles)", () => {
    const H = 3600;
    // 14 flat bars first (no pivots: equal lows/highs) so ATR(14) exists when the pivots confirm.
    const mids = [...Array(14).fill(10), 10, 10, 10, 11, 12, 11, 10, 10, 11, 12, 11, 10, 10, 11, 12, 13, 14, 15, 14, 13, 12];
    const candles = (m: number[], sec: number) => m.map((x, i) => ({ time: i * sec, open: x, high: x + 1, low: x - 1, close: x, volume: 100 }));
    const params = { ...P, left: 2, right: 2, htfLeft: 2, htfRight: 2 };

    it("chart levels, ATR, and the BROKE banner when the last closed bar broke a level", () => {
        const s = srChartState({ candles: candles(mids.slice(0, 31), H), htf: [], params, options: O, chartTf: "1h" });
        expect(s.broke).toMatchObject({ role: "resistance", price: 13, label: "R ×2" });
        expect(s.drawables.map((d) => d.label)).toEqual(["R ×2", "R→S ×2"]);
        expect(s.breaks).toEqual([{ time: 30 * H, direction: "up" }]);
        expect(s.atr).toBeGreaterThan(0);
        expect(srChartState({ candles: candles(mids.slice(0, 32), H), htf: [], params, options: O, chartTf: "1h" }).broke).toBeNull();
    });

    it("HTF levels: only once their confirming HTF bar has closed; dashed + tagged; no break markers", () => {
        const D = 86_400;
        const daily = candles(mids.slice(0, 22), D); // pivot at day 18, confirmed by day 20's close (day 21 00:00)
        const at = (lastChartTime: number) => srChartState({
            candles: [{ time: lastChartTime, open: 10, high: 11, low: 9, close: 10, volume: 1 }],
            htf: [{ tf: "1d", candles: daily }], params, options: { ...O, htf: "1d" }, chartTf: "1h",
        });
        expect(at(21 * D - 2 * H).drawables).toEqual([]); // forming bar opens 23:00 on day 20
        expect(at(21 * D - H).drawables.map((d) => [d.label, d.dashed])).toEqual([["1D R ×1", true]]);
        expect(at(21 * D - H).breaks).toEqual([]);
    });
});

describe("pivot length on the chart's timeframe (Auto / hand-set)", () => {
    it("Auto picks the timeframe's length for left and right; other params unchanged", () => {
        expect(srParamsForTimeframe(P, {}, "1m")).toEqual({ ...P, left: 5, right: 5 });
        expect(srParamsForTimeframe(P, {}, "1h")).toEqual({ ...P, left: 8, right: 8 });
        expect(srParamsForTimeframe(P, {}, "4h")).toEqual({ ...P, left: 10, right: 10 });
        expect(srParamsForTimeframe(P, {}, "1d")).toEqual({ ...P, left: 5, right: 5 });
        expect(srParamsForTimeframe(P, {}, "1w")).toEqual({ ...P, left: 3, right: 3 });
    });

    it("a hand-set timeframe uses its own left/right", () => {
        expect(srParamsForTimeframe(P, { "4h": { left: 7, right: 6 } }, "4h")).toEqual({ ...P, left: 7, right: 6 });
        expect(srParamsForTimeframe(P, { "4h": { left: 7, right: 6 } }, "15m")).toEqual({ ...P, left: 5, right: 5 });
    });

    it("the confirmation text follows the pivot length in use", () => {
        expect(srConfirmText(srParamsForTimeframe(P, {}, "1w"), O, "1w")).toEqual(["confirms after 3w"]);
        expect(srConfirmText(srParamsForTimeframe(P, {}, "1m"), O, "1m")).toEqual(["confirms after 5m"]);
    });
});

describe("labels: only full-strength levels", () => {
    it("full unbroken levels get a label; faded, old and broken ones draw without one", () => {
        const levels = [
            lv({ price: 101 }), lv({ price: 102 }), lv({ price: 103 }), lv({ price: 104 }), // above: 3 full, 1 faded
            lv({ price: 99, role: "support" }),
            lv({ price: 98, role: "support", staleIndex: 3, staleTime: 300 }), // old
            lv({ price: 97, role: "support", brokenIndex: 4, brokenTime: 400 }), // broken
        ];
        const d = buildSRDrawables({ levels, price: 100, nearest: 3, showBroken: true });
        const labelled = d.filter(srLabelled).map((x) => x.price).sort();
        expect(labelled).toEqual([101, 102, 103, 99].sort());
        expect(d.find((x) => x.price === 98)!.label).toContain("old");
        expect(srLabelled(d.find((x) => x.price === 98)!)).toBe(false);
        expect(srLabelled(d.find((x) => x.price === 104)!)).toBe(false);
        expect(srLabelled(d.find((x) => x.price === 97)!)).toBe(false);
    });

    it("never more than `nearest` labels each side per timeframe, however many levels exist", () => {
        const levels = Array.from({ length: 40 }, (_, i) => lv({ price: 60 + i * 2, role: i % 2 ? "resistance" : "support" }));
        const chart = buildSRDrawables({ levels, price: 100, nearest: 3, showBroken: true });
        const htf = buildSRDrawables({ levels, price: 100, nearest: 3, showBroken: true, tag: "1D" });
        expect(chart.length).toBe(40);
        expect(chart.filter(srLabelled).length).toBe(6);
        expect(htf.filter(srLabelled).length).toBe(6);
    });
});
