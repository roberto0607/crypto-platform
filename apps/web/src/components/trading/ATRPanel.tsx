import { useEffect, useRef } from "react";
import {
    createChart,
    LineSeries,
    LineStyle,
    type IChartApi,
    type ISeriesApi,
    type Time,
    type IPriceLine,
} from "lightweight-charts";
import type { Point } from "@/lib/indicators";

interface ATRPanelProps {
    atrData: Point[];
    mainChart: IChartApi | null;
}

export function ATRPanel({ atrData, mainChart }: ATRPanelProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const avgLineRef = useRef<IPriceLine | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            height: 120,
            layout: { background: { color: "#0a0a0a" }, textColor: "#555", fontSize: 9 },
            grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,0.04)" } },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
            timeScale: { visible: false },
            crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
        });

        const series = chart.addSeries(LineSeries, {
            color: "#a855f7", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, priceScaleId: "atr",
        });

        chartRef.current = chart;
        seriesRef.current = series;

        return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; avgLineRef.current = null; };
    }, []);

    // Sync time scale
    useEffect(() => {
        if (!mainChart || !chartRef.current) return;
        const sub = chartRef.current;
        const handler = (range: unknown) => { if (range) sub.timeScale().setVisibleLogicalRange(range as never); };
        mainChart.timeScale().subscribeVisibleLogicalRangeChange(handler);
        return () => mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
    }, [mainChart]);

    // Set data + average mid-line
    useEffect(() => {
        if (!seriesRef.current || atrData.length === 0) return;
        seriesRef.current.setData(atrData.map((p) => ({ time: p.time as Time, value: p.value })));

        // Remove old average line
        if (avgLineRef.current) {
            seriesRef.current.removePriceLine(avgLineRef.current);
            avgLineRef.current = null;
        }

        // Compute average ATR across all data points
        let sum = 0;
        for (const p of atrData) sum += p.value;
        const avg = sum / atrData.length;

        avgLineRef.current = seriesRef.current.createPriceLine({
            price: avg,
            color: "#333333",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: false,
        });
    }, [atrData]);

    const lastATR = atrData.length > 0 ? atrData[atrData.length - 1]!.value : 0;

    return (
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", position: "relative" }}>
            <div style={{ position: "absolute", top: 4, left: 8, fontSize: 9, color: "rgba(255,255,255,0.25)", letterSpacing: 2, zIndex: 5 }}>
                ATR 14
            </div>
            <div style={{ position: "absolute", top: 4, right: 8, fontSize: 9, color: "#a855f7", zIndex: 5 }}>
                ${lastATR.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div ref={containerRef} style={{ height: 120 }} />
        </div>
    );
}
