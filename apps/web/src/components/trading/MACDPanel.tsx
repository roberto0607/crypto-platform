import { useEffect, useRef, useState } from "react";
import {
    createChart,
    LineSeries,
    HistogramSeries,
    LineStyle,
    type IChartApi,
    type ISeriesApi,
    type Time,
} from "lightweight-charts";
import type { MACDResult } from "@/lib/indicators";
import { SubPanelHeader } from "./SubPanelHeader";

interface MACDPanelProps {
    data: MACDResult;
    mainChart: IChartApi | null;
}

export function MACDPanel({ data, mainChart }: MACDPanelProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const macdSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const signalSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const histSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
    const [collapsed, setCollapsed] = useState(true);

    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            height: 100,
            layout: { background: { color: "#0a0a0a" }, textColor: "#555", fontSize: 9 },
            grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,0.04)" } },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
            timeScale: { visible: false },
            crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
        });

        const macdSeries = chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, priceScaleId: "macd" });
        const signalSeries = chart.addSeries(LineSeries, { color: "#f97316", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, priceScaleId: "macd" });
        const histSeries = chart.addSeries(HistogramSeries, { priceScaleId: "macd", priceLineVisible: false, lastValueVisible: false });

        macdSeries.createPriceLine({ price: 0, color: "#444444", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });

        chartRef.current = chart;
        macdSeriesRef.current = macdSeries;
        signalSeriesRef.current = signalSeries;
        histSeriesRef.current = histSeries;

        return () => { chart.remove(); chartRef.current = null; macdSeriesRef.current = null; signalSeriesRef.current = null; histSeriesRef.current = null; };
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
        if (!macdSeriesRef.current || !signalSeriesRef.current || !histSeriesRef.current) return;
        if (data.macd.length === 0) return;
        macdSeriesRef.current.setData(data.macd.map((p) => ({ time: p.time as Time, value: p.value })));
        signalSeriesRef.current.setData(data.signal.map((p) => ({ time: p.time as Time, value: p.value })));
        histSeriesRef.current.setData(data.histogram.map((p) => ({ time: p.time as Time, value: p.value, color: p.value >= 0 ? "#16a34a" : "#dc2626" })));
    }, [data]);

    const lastMacd = data.macd.length > 0 ? data.macd[data.macd.length - 1]!.value : 0;
    const lastSignal = data.signal.length > 0 ? data.signal[data.signal.length - 1]!.value : 0;

    return (
        <div>
            <SubPanelHeader collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} label="MACD 12/26/9"
                rightContent={<><span style={{ color: "#3b82f6" }}>{lastMacd.toFixed(2)}</span>{" "}<span style={{ color: "#f97316" }}>{lastSignal.toFixed(2)}</span></>} />
            <div ref={containerRef} style={{ height: collapsed ? 0 : 100, overflow: "hidden" }} />
        </div>
    );
}
