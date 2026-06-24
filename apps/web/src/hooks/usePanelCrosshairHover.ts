import { useEffect } from "react";
import type { IChartApi, ISeriesApi, MouseEventParams, SeriesType } from "lightweight-charts";

/**
 * Shared sub-panel hover readout — encapsulates the per-panel main-chart
 * crosshair subscription used by RSI/CVD/MACD/ATR/Delta/Funding/OI.
 *
 * On main-crosshair move it resolves the panel's value at the cursor time via
 * the caller's `lookup`, projects a synced marker onto the panel chart
 * (`setCrosshairPosition`), and pushes the value through `setHovered`. Off-chart
 * (or no match) it clears the marker and reverts to latest.
 *
 * The per-panel variance lives ENTIRELY in `lookup` (exact-match, index-aligned
 * multi-value, step-lookup, etc.) and the marker series. PR 1 is main-only — a
 * pure extraction of today's behavior; the panel's own self-hover subscription
 * is added here in PR 2.
 */
interface PanelCrosshairHoverArgs<T> {
    /** The main price chart whose crosshair drives this panel. `null` → no subscription. */
    mainChart: IChartApi | null;
    /** The panel's own chart (read at fire time so a remount can't leak). */
    getChart: () => IChartApi | null;
    /** The series the synced marker is projected onto. */
    getSeries: () => ISeriesApi<SeriesType> | null;
    /** Resolve the panel's value + marker price at a cursor time; `null` = no value. */
    lookup: (time: number) => { value: T; price: number } | null;
    /** Push the hovered value (or `null` to revert to latest). */
    setHovered: (v: T | null) => void;
    /** Data identity — re-subscribes so the `lookup` closure stays fresh. */
    deps: unknown[];
}

export function usePanelCrosshairHover<T>({
    mainChart,
    getChart,
    getSeries,
    lookup,
    setHovered,
    deps,
}: PanelCrosshairHoverArgs<T>): void {
    useEffect(() => {
        if (!mainChart) return;
        const handler = (param: MouseEventParams) => {
            const sub = getChart();
            const series = getSeries();
            if (!sub || !series) return;
            if (param.time == null) { sub.clearCrosshairPosition(); setHovered(null); return; }
            const r = lookup(param.time as number);
            if (!r) { sub.clearCrosshairPosition(); setHovered(null); return; }
            sub.setCrosshairPosition(r.price, param.time, series);
            setHovered(r.value);
        };
        mainChart.subscribeCrosshairMove(handler);
        return () => mainChart.unsubscribeCrosshairMove(handler);
        // `lookup`/`getChart`/`getSeries`/`setHovered` are captured fresh whenever
        // `deps` (the data identity) changes — matching each panel's original
        // `[mainChart, <data>]` dependency list exactly.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mainChart, ...deps]);
}
