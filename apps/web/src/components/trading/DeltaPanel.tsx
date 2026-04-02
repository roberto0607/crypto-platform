import { useEffect, useRef, useState } from "react";
import {
    createChart,
    HistogramSeries,
    LineStyle,
    type IChartApi,
    type ISeriesApi,
    type Time,
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

    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            height: 80,
            layout: { background: { color: "#0a0a0a" }, textColor: "#555", fontSize: 9 },
            grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,0.04)" } },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
            timeScale: { visible: false },
            crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
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
        const handler = (range: unknown) => { if (range) sub.timeScale().setVisibleRange(range as never); };
        mainChart.timeScale().subscribeVisibleTimeRangeChange(handler);
        return () => mainChart.timeScale().unsubscribeVisibleTimeRangeChange(handler);
    }, [mainChart]);

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
    const fmtDelta = Math.abs(lastDelta) >= 1000 ? (lastDelta / 1000).toFixed(1) + "K" : lastDelta.toFixed(0);

    return (
        <div>
            <SubPanelHeader collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} label="EST. DELTA"
                rightContent={<span style={{ color: lastDelta >= 0 ? "#22c55e" : "#ef4444" }}>{lastDelta >= 0 ? "+" : ""}{fmtDelta}</span>} />
            <div ref={containerRef} style={{ height: collapsed ? 0 : (externalHeight ?? 80), overflow: "hidden" }} />
        </div>
    );
}
