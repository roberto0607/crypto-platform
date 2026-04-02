import { useEffect, useRef, useState } from "react";
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
import { SubPanelHeader } from "./SubPanelHeader";

interface ATRPanelProps {
    atrData: Point[];
    mainChart: IChartApi | null;
    height?: number;
}

export function ATRPanel({ atrData, mainChart, height: externalHeight }: ATRPanelProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const avgLineRef = useRef<IPriceLine | null>(null);
    const [collapsed, setCollapsed] = useState(true);

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

        const series = chart.addSeries(LineSeries, { color: "#a855f7", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, priceScaleId: "atr" });

        chartRef.current = chart;
        seriesRef.current = series;

        return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; avgLineRef.current = null; };
    }, []);

    useEffect(() => {
        if (!mainChart || !chartRef.current) return;
        const sub = chartRef.current;
        const handler = (range: unknown) => { if (range) sub.timeScale().setVisibleLogicalRange(range as never); };
        mainChart.timeScale().subscribeVisibleLogicalRangeChange(handler);
        return () => mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
    }, [mainChart]);

    useEffect(() => {
        if (chartRef.current && !collapsed && externalHeight) chartRef.current.applyOptions({ height: externalHeight });
    }, [externalHeight, collapsed]);

    useEffect(() => {
        if (!seriesRef.current || atrData.length === 0) return;
        seriesRef.current.setData(atrData.map((p) => ({ time: p.time as Time, value: p.value })));

        if (avgLineRef.current) { seriesRef.current.removePriceLine(avgLineRef.current); avgLineRef.current = null; }
        let sum = 0;
        for (const p of atrData) sum += p.value;
        avgLineRef.current = seriesRef.current.createPriceLine({ price: sum / atrData.length, color: "#333333", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });

        if (mainChart && chartRef.current) {
            const range = mainChart.timeScale().getVisibleLogicalRange();
            if (range) requestAnimationFrame(() => { chartRef.current?.timeScale().setVisibleLogicalRange(range); });
        }
    }, [atrData, mainChart]);

    useEffect(() => {
        if (collapsed || !mainChart || !chartRef.current) return;
        requestAnimationFrame(() => {
            const range = mainChart.timeScale().getVisibleLogicalRange();
            if (range) chartRef.current?.timeScale().setVisibleLogicalRange(range);
        });
    }, [collapsed, mainChart]);

    const lastATR = atrData.length > 0 ? atrData[atrData.length - 1]!.value : 0;

    return (
        <div>
            <SubPanelHeader collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} label="ATR 14"
                rightContent={<span style={{ color: "#a855f7" }}>${lastATR.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>} />
            <div ref={containerRef} style={{ height: collapsed ? 0 : (externalHeight ?? 120), overflow: "hidden" }} />
        </div>
    );
}
