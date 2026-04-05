import { useEffect, useRef, useState } from "react";
import {
    createChart,
    HistogramSeries,
    type IChartApi,
    type ISeriesApi,
    type Time,
} from "lightweight-charts";
import type { Candle } from "@/api/endpoints/candles";
import { SubPanelHeader } from "./SubPanelHeader";

const TZ_OFFSET_SEC = new Date().getTimezoneOffset() * -60;

interface VolumePanelProps {
    candles: Candle[];
    mainChart: IChartApi | null;
    height?: number;
}

export function VolumePanel({ candles, mainChart, height: externalHeight }: VolumePanelProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
    const [collapsed, setCollapsed] = useState(true);

    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            height: 80,
            layout: { background: { color: "#0a0a0a" }, textColor: "#555", fontSize: 9 },
            grid: { vertLines: { visible: false }, horzLines: { visible: false } },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0 } },
            timeScale: { visible: false },
            crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
        });

        const series = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume" });

        chartRef.current = chart;
        seriesRef.current = series;

        return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; };
    }, []);

    useEffect(() => {
        if (!mainChart || !chartRef.current) return;
        const sub = chartRef.current;
        const handler = (range: unknown) => { console.log("VOLUME received:", JSON.stringify(range)); if (range) { sub.timeScale().setVisibleLogicalRange(range as never); console.log("VOLUME after set:", JSON.stringify(sub.timeScale().getVisibleLogicalRange())); } };
        mainChart.timeScale().subscribeVisibleLogicalRangeChange(handler);
        // Sync immediately on mount
        const currentRange = mainChart.timeScale().getVisibleLogicalRange();
        if (currentRange) sub.timeScale().setVisibleLogicalRange(currentRange);
        return () => mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
    }, [mainChart]);

    // Resize chart when height changes
    useEffect(() => {
        if (chartRef.current && !collapsed && externalHeight) {
            chartRef.current.applyOptions({ height: externalHeight });
        }
    }, [externalHeight, collapsed]);

    useEffect(() => {
        if (!seriesRef.current || candles.length === 0) return;
        const data = candles.map((c) => ({
            time: (new Date(c.ts).getTime() / 1000 + TZ_OFFSET_SEC) as Time,
            value: parseFloat(c.volume),
            color: parseFloat(c.close) >= parseFloat(c.open) ? "rgba(0,255,65,0.35)" : "rgba(255,59,59,0.35)",
        }));
        seriesRef.current.setData(data);
    }, [candles]);

    const lastVol = candles.length > 0 ? parseFloat(candles[candles.length - 1]!.volume) : 0;
    const fmtVol = lastVol >= 1_000_000 ? (lastVol / 1_000_000).toFixed(1) + "M" : lastVol >= 1000 ? (lastVol / 1000).toFixed(0) + "K" : lastVol.toFixed(0);

    return (
        <div>
            <SubPanelHeader collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} label="VOLUME"
                rightContent={<span style={{ color: "rgba(255,255,255,0.4)" }}>{fmtVol}</span>} />
            <div ref={containerRef} style={{ height: collapsed ? 0 : (externalHeight ?? 80), overflow: "hidden" }} />
        </div>
    );
}
