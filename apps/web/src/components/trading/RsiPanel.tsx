import { useEffect, useRef } from "react";
import {
    createChart,
    LineSeries,
    LineStyle,
    type IChartApi,
    type ISeriesApi,
    type Time,
} from "lightweight-charts";
import type { Point } from "@/lib/indicators";

interface RsiPanelProps {
    rsiData: Point[];
    mainChart: IChartApi | null;
}

export function RsiPanel({ rsiData, mainChart }: RsiPanelProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            height: 80,
            layout: {
                background: { color: "#0a0a0a" },
                textColor: "#555",
                fontSize: 9,
            },
            grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,0.04)" } },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.05, bottom: 0.05 } },
            timeScale: { visible: false },
            crosshair: {
                vertLine: { visible: false },
                horzLine: { visible: false },
            },
        });

        const series = chart.addSeries(LineSeries, {
            color: "#f59e0b",
            lineWidth: 1,
            priceScaleId: "rsi",
        });

        // Overbought / oversold lines
        series.createPriceLine({ price: 70, color: "rgba(255,59,59,0.4)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
        series.createPriceLine({ price: 30, color: "rgba(0,255,65,0.4)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
        series.createPriceLine({ price: 50, color: "rgba(255,255,255,0.08)", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false });

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
        if (!seriesRef.current || rsiData.length === 0) return;
        const data = rsiData.map((p) => ({
            time: p.time as Time,
            value: p.value,
        }));
        seriesRef.current.setData(data);
    }, [rsiData]);

    return (
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", position: "relative" }}>
            <div style={{ position: "absolute", top: 4, left: 8, fontSize: 9, color: "rgba(255,255,255,0.25)", letterSpacing: 2, zIndex: 5 }}>RSI 14</div>
            <div ref={containerRef} style={{ height: 80 }} />
        </div>
    );
}
