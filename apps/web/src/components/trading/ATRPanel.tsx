import { useEffect, useRef, useState } from "react";
import {
    createChart,
    LineSeries,
    LineStyle,
    type IChartApi,
    type ISeriesApi,
    type Time,
    type IPriceLine,
    type MouseEventParams,
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
    const [hovered, setHovered] = useState<number | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            height: 120,
            layout: { background: { color: "#0a0a0a" }, textColor: "#555", fontSize: 9 },
            grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,0.04)" } },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
            timeScale: { visible: false },
            crosshair: {
                vertLine: { visible: true, color: "rgba(255,255,255,0.2)", width: 1, labelVisible: false },
                horzLine: { visible: false },
            },
        });

        const series = chart.addSeries(LineSeries, { color: "#a855f7", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, priceScaleId: "atr" });

        chartRef.current = chart;
        seriesRef.current = series;

        return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; avgLineRef.current = null; };
    }, []);

    useEffect(() => {
        if (!mainChart || !chartRef.current) return;
        const sub = chartRef.current;
        const handler = (range: unknown) => {
            // Guard the empty-chart race: lightweight-charts throws "Value is null"
            // if setVisibleLogicalRange runs before this panel's series has data.
            if (!range || atrData.length === 0) return;
            const r = range as { from: number; to: number };
            const len = atrData.length || 750;
            const pad = Math.max(0, r.to - (len - 1));
            sub.timeScale().setVisibleLogicalRange({ from: r.from - pad, to: r.to - pad } as never);
        };
        mainChart.timeScale().subscribeVisibleLogicalRangeChange(handler);
        return () => mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
    }, [mainChart, atrData.length]);

    // Hover readout: mirror the main chart's crosshair onto this panel and show
    // the exact ATR at the cursor's time (exact match — data is 1:1 with candles
    // on the same TZ_OFFSET_SEC domain). Off-chart reverts to the latest value.
    useEffect(() => {
        if (!mainChart) return;
        const handler = (param: MouseEventParams) => {
            const sub = chartRef.current;
            const series = seriesRef.current;
            if (!sub || !series) return;
            if (param.time == null) { sub.clearCrosshairPosition(); setHovered(null); return; }
            const t = param.time as number;
            const point = atrData.find((p) => p.time === t);
            if (!point) { sub.clearCrosshairPosition(); setHovered(null); return; }
            sub.setCrosshairPosition(point.value, param.time, series);
            setHovered(point.value);
        };
        mainChart.subscribeCrosshairMove(handler);
        return () => mainChart.unsubscribeCrosshairMove(handler);
    }, [mainChart, atrData]);

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
            const range = mainChart.timeScale().getVisibleRange();
            if (range) requestAnimationFrame(() => { chartRef.current?.timeScale().setVisibleRange(range); });
        }
    }, [atrData, mainChart]);

    useEffect(() => {
        if (collapsed || !mainChart || !chartRef.current) return;
        requestAnimationFrame(() => {
            const range = mainChart.timeScale().getVisibleRange();
            if (range) chartRef.current?.timeScale().setVisibleRange(range);
        });
    }, [collapsed, mainChart]);

    const lastATR = atrData.length > 0 ? atrData[atrData.length - 1]!.value : 0;
    const shownATR = hovered ?? lastATR;

    return (
        <div>
            <SubPanelHeader collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} label="ATR 14"
                rightContent={<span style={{ color: "#a855f7" }}>${shownATR.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>} />
            <div ref={containerRef} style={{ height: collapsed ? 0 : (externalHeight ?? 120), overflow: "hidden" }} />
        </div>
    );
}
