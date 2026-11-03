import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import type { IChartApi } from "lightweight-charts";
import type { Candle } from "@/api/endpoints/candles";
import { VPVRPrimitive } from "@/lib/vpvrPrimitive";
import { useVpvrProfile } from "@/hooks/useVpvrProfile";
import fixture from "@/lib/__tests__/fixtures/btcVpvr.json";

// Audit 2026-11 B-04, with the audit's candles (BTC/USD, last 130 closed bars
// of each timeframe at 2026-11-03 ~04:55Z; rows [utcSec, high, low, volume]).
// Visible window = the last 120 bars, which is what the chart shows after a
// switch (barCount − 120 … barCount + 2) — for 1h AND for 4h, so switching
// fires no visible-range change. Expected (independent recompute, audit §3):
//   1h: POC 77,243 · VAH 78,345 · VAL 76,428
//   4h: POC 81,588 · VAH 84,275 · VAL 79,191

const toCandles = (rows: number[][]): Candle[] => rows.map(([t, high, low, volume]) => ({
    ts: new Date(t! * 1000).toISOString(), open: "0", high: String(high), low: String(low), close: "0", volume: String(volume),
}));

function fakeChart(): IChartApi {
    const range = { from: 10, to: 132 }; // bars 10..129 of 130 = the last 120 — same on both TFs
    return {
        timeScale: () => ({
            getVisibleLogicalRange: () => range,
            subscribeVisibleLogicalRangeChange: () => {},
            unsubscribeVisibleLogicalRangeChange: () => {},
        }),
    } as unknown as IChartApi;
}

/** The levels exactly as vpvrPrimitive draws them. */
function drawnLevels(vpvr: VPVRPrimitive) {
    const d = vpvr.vpvrData!;
    return {
        poc: Math.round(d.min + (d.pocIndex + 0.5) * d.bucketSize),
        vah: Math.round(d.min + (d.vahIndex + 1) * d.bucketSize),
        val: Math.round(d.min + d.valIndex * d.bucketSize),
    };
}

describe("useVpvrProfile — recomputes when a new history lands (audit B-04)", () => {
    it("1h → 4h gives the 4h profile, with no visible-range change", () => {
        const vpvr = new VPVRPrimitive();
        const refs = {
            chartRef: { current: fakeChart() },
            vpvrRef: { current: vpvr },
            rawCandlesRef: { current: toCandles(fixture["1h"]) },
        };
        const { rerender } = renderHook((p: { historyVersion: number }) =>
            useVpvrProfile({ ...refs, enabled: true, mode: "visible", historyVersion: p.historyVersion }),
            { initialProps: { historyVersion: 1 } });
        expect(drawnLevels(vpvr)).toEqual({ poc: 77243, vah: 78345, val: 76428 });

        // What fetchCandles does on the switch: swap the history, bump the version.
        refs.rawCandlesRef.current = toCandles(fixture["4h"]);
        rerender({ historyVersion: 2 });
        expect(drawnLevels(vpvr)).toEqual({ poc: 81588, vah: 84275, val: 79191 });
    });

    it("pair switch (same bar count) recomputes too", () => {
        const vpvr = new VPVRPrimitive();
        const refs = {
            chartRef: { current: fakeChart() },
            vpvrRef: { current: vpvr },
            rawCandlesRef: { current: toCandles(fixture["4h"]) },
        };
        const { rerender } = renderHook((p: { historyVersion: number }) =>
            useVpvrProfile({ ...refs, enabled: true, mode: "visible", historyVersion: p.historyVersion }),
            { initialProps: { historyVersion: 1 } });
        // "Another pair": the same bars at 1/30th the price.
        refs.rawCandlesRef.current = toCandles(fixture["4h"].map(([t, h, l, v]) => [t!, h! / 30, l! / 30, v!]));
        rerender({ historyVersion: 2 });
        expect(Math.abs(drawnLevels(vpvr).poc - 81588 / 30)).toBeLessThan(1);
    });
});
