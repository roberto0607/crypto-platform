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
 * Also subscribes the panel's OWN chart crosshair so the readout updates when
 * the cursor is over the panel itself (the native crosshair already draws the
 * marker, so the self-handler does NOT call `setCrosshairPosition`). The two
 * subscriptions never cross-fire: `setCrosshairPosition`/`clearCrosshairPosition`
 * pass `skipEvent=true`, so the main path's programmatic crosshair updates can't
 * re-trigger the own subscription. The cursor is over exactly one chart at a
 * time, both call the same `setHovered`, and each clears on its own `null`.
 *
 * The per-panel variance lives ENTIRELY in `lookup` (exact-match, index-aligned
 * multi-value, step-lookup, etc.) and the marker series. A panel that can't
 * main-sync (COT — its own x-domain) passes `mainChart: null` → self-only.
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
        const cleanups: Array<() => void> = [];

        // Price-chart hover: the main crosshair drives this panel — resolve the
        // value at the cursor time and PROJECT a synced marker onto the panel.
        if (mainChart) {
            const mainHandler = (param: MouseEventParams) => {
                const sub = getChart();
                const series = getSeries();
                if (!sub || !series) return;
                if (param.time == null) { sub.clearCrosshairPosition(); setHovered(null); return; }
                const r = lookup(param.time as number);
                if (!r) { sub.clearCrosshairPosition(); setHovered(null); return; }
                sub.setCrosshairPosition(r.price, param.time, series);
                setHovered(r.value);
            };
            mainChart.subscribeCrosshairMove(mainHandler);
            cleanups.push(() => mainChart.unsubscribeCrosshairMove(mainHandler));
        }

        // Self hover: cursor over THIS panel. The native crosshair already draws
        // the marker, so DON'T setCrosshairPosition — just read the value. The
        // own param.time snaps to a data point's time (same domain `lookup` uses).
        const own = getChart();
        if (own) {
            const ownHandler = (param: MouseEventParams) => {
                if (param.time == null) { setHovered(null); return; }
                const r = lookup(param.time as number);
                setHovered(r ? r.value : null);
            };
            own.subscribeCrosshairMove(ownHandler);
            cleanups.push(() => own.unsubscribeCrosshairMove(ownHandler));
        }

        return () => { for (const off of cleanups) off(); };
        // `lookup`/`getChart`/`getSeries`/`setHovered` are captured fresh whenever
        // `deps` (the data identity) changes — matching each panel's original
        // `[mainChart, <data>]` dependency list exactly.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mainChart, ...deps]);
}
