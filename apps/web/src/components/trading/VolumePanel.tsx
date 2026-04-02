import { useEffect, useRef } from "react";
import {
    createChart,
    HistogramSeries,
    type IChartApi,
    type ISeriesApi,
    type Time,
} from "lightweight-charts";
import type { Candle } from "@/api/endpoints/candles";

const TZ_OFFSET_SEC = new Date().getTimezoneOffset() * -60;

interface VolumePanelProps {
    candles: Candle[];
    mainChart: IChartApi | null;
}

export function VolumePanel({ candles, mainChart }: VolumePanelProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            height: 80,
            layout: {
                background: { color: "#0a0a0a" },
                textColor: "#555",
                fontSize: 9,
            },
            grid: { vertLines: { visible: false }, horzLines: { visible: false } },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0 } },
            timeScale: { visible: false },
            crosshair: {
                vertLine: { visible: false },
                horzLine: { visible: false },
            },
        });

        const series = chart.addSeries(HistogramSeries, {
            priceFormat: { type: "volume" },
            priceScaleId: "volume",
        });

        chartRef.current = chart;
        seriesRef.current = series;

        return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; };
    }, []);

    // Sync time scale with main chart
    useEffect(() => {
        if (!mainChart || !chartRef.current) return;
        const sub = chartRef.current;
        const handler = (range: unknown) => { if (range) sub.timeScale().setVisibleLogicalRange(range as never); };
        mainChart.timeScale().subscribeVisibleLogicalRangeChange(handler);
        return () => mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
    }, [mainChart]);

    // Set data
    useEffect(() => {
        if (!seriesRef.current || candles.length === 0) return;
        const data = candles.map((c) => ({
            time: (new Date(c.ts).getTime() / 1000 + TZ_OFFSET_SEC) as Time,
            value: parseFloat(c.volume),
            color: parseFloat(c.close) >= parseFloat(c.open)
                ? "rgba(0,255,65,0.35)"
                : "rgba(255,59,59,0.35)",
        }));
        seriesRef.current.setData(data);
    }, [candles]);

    return (
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
            <div ref={containerRef} style={{ height: 80 }} />
        </div>
    );
}
