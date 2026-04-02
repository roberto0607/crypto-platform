import { useEffect, useRef, useState } from "react";
import {
    createChart,
    LineSeries,
    LineStyle,
    type IChartApi,
    type ISeriesApi,
    type Time,
} from "lightweight-charts";
import type { Point } from "@/lib/indicators";
import { SubPanelHeader } from "./SubPanelHeader";

interface RsiPanelProps {
    rsiData: Point[];
    mainChart: IChartApi | null;
}

export function RsiPanel({ rsiData, mainChart }: RsiPanelProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const [collapsed, setCollapsed] = useState(true);

    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            height: 80,
            layout: { background: { color: "#0a0a0a" }, textColor: "#555", fontSize: 9 },
            grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,0.04)" } },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.05, bottom: 0.05 } },
            timeScale: { visible: false },
            crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
        });

        const series = chart.addSeries(LineSeries, { color: "#f59e0b", lineWidth: 1, priceScaleId: "rsi" });
        series.createPriceLine({ price: 70, color: "rgba(255,59,59,0.4)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
        series.createPriceLine({ price: 30, color: "rgba(0,255,65,0.4)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
        series.createPriceLine({ price: 50, color: "rgba(255,255,255,0.08)", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false });

        chartRef.current = chart;
        seriesRef.current = series;

        return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; };
    }, []);

    useEffect(() => {
        if (!mainChart || !chartRef.current) return;
        const sub = chartRef.current;
        const handler = (range: unknown) => { if (range) sub.timeScale().setVisibleLogicalRange(range as never); };
        mainChart.timeScale().subscribeVisibleLogicalRangeChange(handler);
        const currentRange = mainChart.timeScale().getVisibleLogicalRange();
        if (currentRange) sub.timeScale().setVisibleLogicalRange(currentRange);
        return () => mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
    }, [mainChart]);

    useEffect(() => {
        if (!seriesRef.current || rsiData.length === 0) return;
        seriesRef.current.setData(rsiData.map((p) => ({ time: p.time as Time, value: p.value })));
    }, [rsiData]);

    const lastRsi = rsiData.length > 0 ? rsiData[rsiData.length - 1]!.value : 0;

    return (
        <div>
            <SubPanelHeader collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} label="RSI 14"
                rightContent={<span style={{ color: lastRsi > 70 ? "#ff3b3b" : lastRsi < 30 ? "#00ff41" : "#f59e0b" }}>{lastRsi.toFixed(1)}</span>} />
            <div ref={containerRef} style={{ height: collapsed ? 0 : 80, overflow: "hidden" }} />
        </div>
    );
}
