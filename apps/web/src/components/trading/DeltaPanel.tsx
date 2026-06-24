import { useEffect, useRef, useState } from "react";
import {
    createChart,
    HistogramSeries,
    LineStyle,
    type IChartApi,
    type ISeriesApi,
    type Time,
    type MouseEventParams,
} from "lightweight-charts";
import type { Point } from "@/lib/indicators";
import { SubPanelHeader } from "./SubPanelHeader";

interface DeltaPanelProps {
    deltaData: Point[];
    mainChart: IChartApi | null;
    height?: number;
}

export function DeltaPanel({ deltaData, mainChart, height: externalHeight }: DeltaPanelProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
    const [collapsed, setCollapsed] = useState(true);
    const [hovered, setHovered] = useState<number | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            height: 80,
            layout: { background: { color: "#0a0a0a" }, textColor: "#555", fontSize: 9 },
            grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,0.04)" } },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
            timeScale: { visible: false },
            crosshair: {
                vertLine: { visible: true, color: "rgba(255,255,255,0.2)", width: 1, labelVisible: false },
                horzLine: { visible: false },
            },
        });

        const series = chart.addSeries(HistogramSeries, { priceScaleId: "delta", priceLineVisible: false, lastValueVisible: false });
        const zeroSeries = chart.addSeries(HistogramSeries, { priceScaleId: "delta", priceLineVisible: false, lastValueVisible: false });
        zeroSeries.createPriceLine({ price: 0, color: "#444444", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });

        chartRef.current = chart;
        seriesRef.current = series;

        return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; };
    }, []);

    useEffect(() => {
        if (!mainChart || !chartRef.current) return;
        const sub = chartRef.current;
        const handler = (range: unknown) => {
            // Guard the empty-chart race: lightweight-charts throws "Value is null"
            // if setVisibleLogicalRange runs before this panel's series has data.
            if (!range || deltaData.length === 0) return;
            const r = range as { from: number; to: number };
            const len = deltaData.length || 750;
            const pad = Math.max(0, r.to - (len - 1));
            sub.timeScale().setVisibleLogicalRange({ from: r.from - pad, to: r.to - pad } as never);
        };
        mainChart.timeScale().subscribeVisibleLogicalRangeChange(handler);
        return () => mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
    }, [mainChart, deltaData.length]);

    // Hover readout: mirror the main chart's crosshair and show the exact delta
    // at the cursor's time (exact match — 1:1 with candles, same TZ domain).
    useEffect(() => {
        if (!mainChart) return;
        const handler = (param: MouseEventParams) => {
            const sub = chartRef.current;
            const series = seriesRef.current;
            if (!sub || !series) return;
            if (param.time == null) { sub.clearCrosshairPosition(); setHovered(null); return; }
            const t = param.time as number;
            const point = deltaData.find((p) => p.time === t);
            if (!point) { sub.clearCrosshairPosition(); setHovered(null); return; }
            sub.setCrosshairPosition(point.value, param.time, series);
            setHovered(point.value);
        };
        mainChart.subscribeCrosshairMove(handler);
        return () => mainChart.unsubscribeCrosshairMove(handler);
    }, [mainChart, deltaData]);

    useEffect(() => {
        if (chartRef.current && !collapsed && externalHeight) chartRef.current.applyOptions({ height: externalHeight });
    }, [externalHeight, collapsed]);

    useEffect(() => {
        if (!seriesRef.current || deltaData.length === 0) return;
        seriesRef.current.setData(deltaData.map((p) => ({ time: p.time as Time, value: p.value, color: p.value >= 0 ? "#22c55e" : "#ef4444" })));
        if (mainChart && chartRef.current) {
            const range = mainChart.timeScale().getVisibleRange();
            if (range) requestAnimationFrame(() => { chartRef.current?.timeScale().setVisibleRange(range); });
        }
    }, [deltaData, mainChart]);

    useEffect(() => {
        if (collapsed || !mainChart || !chartRef.current) return;
        requestAnimationFrame(() => {
            const range = mainChart.timeScale().getVisibleRange();
            if (range) chartRef.current?.timeScale().setVisibleRange(range);
        });
    }, [collapsed, mainChart]);

    const lastDelta = deltaData.length > 0 ? deltaData[deltaData.length - 1]!.value : 0;
    const shownDelta = hovered ?? lastDelta;
    const fmtDelta = Math.abs(shownDelta) >= 1000 ? (shownDelta / 1000).toFixed(1) + "K" : shownDelta.toFixed(0);

    return (
        <div>
            <SubPanelHeader collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} label="EST. DELTA"
                rightContent={<span style={{ color: shownDelta >= 0 ? "#22c55e" : "#ef4444" }}>{shownDelta >= 0 ? "+" : ""}{fmtDelta}</span>} />
            <div ref={containerRef} style={{ height: collapsed ? 0 : (externalHeight ?? 80), overflow: "hidden" }} />
        </div>
    );
}
