import { useEffect, useRef, type MutableRefObject } from "react";
import type { IChartApi } from "lightweight-charts";
import type { Candle } from "@/api/endpoints/candles";
import type { VPVRCandle, VPVRPrimitive } from "@/lib/vpvrPrimitive";

/**
 * Drives the VPVR primitive (moved verbatim from CandlestickChart).
 *
 * `historyVersion` must change every time a NEW candle history lands
 * (pair or timeframe switch). Without it, "visible" mode only recomputed on a
 * visible-range change — and 1h→4h (or BTC→ETH) keeps the same 750 bars and
 * the same 120-bar window, so no event fired and the old profile stayed
 * (audit 2026-11 B-04). Weekly/daily modes polled the candle COUNT, which a
 * switch doesn't change either.
 */
export function useVpvrProfile(opts: {
    chartRef: MutableRefObject<IChartApi | null>;
    vpvrRef: MutableRefObject<VPVRPrimitive | null>;
    rawCandlesRef: MutableRefObject<Candle[]>;
    enabled: boolean;
    mode: "visible" | "weekly" | "daily";
    historyVersion: number;
}): void {
    const { chartRef, vpvrRef: vpvrPrimitiveRef, rawCandlesRef, enabled, mode, historyVersion } = opts;
    const vpvrDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const vpvrWeeklyLenRef = useRef(0);

    useEffect(() => {
        const chart = chartRef.current;
        const vpvr = vpvrPrimitiveRef.current;
        if (!chart || !vpvr) return;

        if (!enabled) {
            vpvr.update([]);
            return;
        }

        const parseCandle = (c: { high: string; low: string; volume: string }): VPVRCandle =>
            ({ high: parseFloat(c.high), low: parseFloat(c.low), volume: parseFloat(c.volume) });

        // Weekly boundary: most recent Sunday 22:00 UTC
        const getWeeklyOpen = (): Date => {
            const now = new Date();
            const day = now.getUTCDay();
            const hour = now.getUTCHours();
            let daysSinceSunday = day;
            if (day === 0 && hour < 22) daysSinceSunday = 7;
            const d = new Date(now);
            d.setUTCDate(now.getUTCDate() - daysSinceSunday);
            d.setUTCHours(22, 0, 0, 0);
            return d;
        };

        const updateVisibleVPVR = () => {
            const range = chart.timeScale().getVisibleLogicalRange();
            if (!range || !rawCandlesRef.current.length) return;
            const from = Math.max(0, Math.floor(range.from));
            const to = Math.min(rawCandlesRef.current.length - 1, Math.ceil(range.to));
            const visible: VPVRCandle[] = [];
            for (let i = from; i <= to; i++) {
                const c = rawCandlesRef.current[i];
                if (c) visible.push(parseCandle(c));
            }
            vpvr.update(visible, "visible");
        };

        const updateWeeklyVPVR = () => {
            if (!rawCandlesRef.current.length) return;
            const weeklyOpen = getWeeklyOpen();
            const weekly: VPVRCandle[] = [];
            for (const c of rawCandlesRef.current) {
                if (new Date(c.ts) >= weeklyOpen) weekly.push(parseCandle(c));
            }
            vpvr.update(weekly, "weekly");
            vpvrWeeklyLenRef.current = rawCandlesRef.current.length;
        };

        // Daily boundary: current UTC midnight
        const getDailyOpen = (): Date => {
            const now = new Date();
            const d = new Date(now);
            d.setUTCHours(0, 0, 0, 0);
            return d;
        };

        const updateDailyVPVR = () => {
            if (!rawCandlesRef.current.length) return;
            const dailyOpen = getDailyOpen();
            const daily: VPVRCandle[] = [];
            for (const c of rawCandlesRef.current) {
                if (new Date(c.ts) >= dailyOpen) daily.push(parseCandle(c));
            }
            vpvr.update(daily, "daily");
            vpvrWeeklyLenRef.current = rawCandlesRef.current.length;
        };

        if (mode === "visible") {
            updateVisibleVPVR();
            const handler = () => {
                if (vpvrDebounceRef.current) clearTimeout(vpvrDebounceRef.current);
                vpvrDebounceRef.current = setTimeout(updateVisibleVPVR, 50);
            };
            chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
            return () => {
                chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
                if (vpvrDebounceRef.current) clearTimeout(vpvrDebounceRef.current);
            };
        } else {
            // Fixed mode (weekly or daily): compute once, recalc only on new candle
            const updateFixed = mode === "weekly" ? updateWeeklyVPVR : updateDailyVPVR;
            updateFixed();
            const checkNewCandle = setInterval(() => {
                if (rawCandlesRef.current.length !== vpvrWeeklyLenRef.current) {
                    updateFixed();
                }
            }, 5000);
            return () => clearInterval(checkNewCandle);
        }
    }, [enabled, mode, historyVersion, chartRef, vpvrPrimitiveRef, rawCandlesRef]);
}
