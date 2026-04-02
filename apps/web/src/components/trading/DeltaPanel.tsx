import { useEffect, useRef } from "react";
import {
    createChart,
    HistogramSeries,
    LineStyle,
    type IChartApi,
    type ISeriesApi,
    type Time,
} from "lightweight-charts";
import type { Point } from "@/lib/indicators";

interface DeltaPanelProps {
    deltaData: Point[];
    mainChart: IChartApi | null;
}

export function DeltaPanel({ deltaData, mainChart }: DeltaPanelProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

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

        const series = chart.addSeries(HistogramSeries, {
            priceScaleId: "delta", priceLineVisible: false, lastValueVisible: false,
        });

        // Zero line via a transparent line series
        const zeroSeries = chart.addSeries(HistogramSeries, {
            priceScaleId: "delta", priceLineVisible: false, lastValueVisible: false,
        });
        zeroSeries.createPriceLine({
            price: 0, color: "#444444", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false,
        });

        chartRef.current = chart;
        seriesRef.current = series;

        return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; };
    }, []);

    // Sync time scale
    useEffect(() => {
        if (!mainChart || !chartRef.current) return;
        const sub = chartRef.current;
        const handler = (range: unknown) => { if (range) sub.timeScale().setVisibleLogicalRange(range as never); };
        mainChart.timeScale().subscribeVisibleLogicalRangeChange(handler);
        return () => mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
    }, [mainChart]);

    // Set data
    useEffect(() => {
        if (!seriesRef.current || deltaData.length === 0) return;
        seriesRef.current.setData(deltaData.map((p) => ({
            time: p.time as Time,
            value: p.value,
            color: p.value >= 0 ? "#22c55e" : "#ef4444",
        })));
    }, [deltaData]);

    const lastDelta = deltaData.length > 0 ? deltaData[deltaData.length - 1]!.value : 0;
    const fmtDelta = Math.abs(lastDelta) >= 1000
        ? (lastDelta / 1000).toFixed(1) + "K"
        : lastDelta.toFixed(0);

    return (
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", position: "relative" }}>
            <div style={{ position: "absolute", top: 4, left: 8, fontSize: 9, color: "rgba(255,255,255,0.25)", letterSpacing: 2, zIndex: 5 }}>
                EST. DELTA
            </div>
            <div style={{ position: "absolute", top: 4, right: 8, fontSize: 9, color: lastDelta >= 0 ? "#22c55e" : "#ef4444", zIndex: 5 }}>
                {lastDelta >= 0 ? "+" : ""}{fmtDelta}
            </div>
            <div ref={containerRef} style={{ height: 80 }} />
        </div>
    );
}
