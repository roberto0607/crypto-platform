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
import { usePanelCrosshairHover } from "@/hooks/usePanelCrosshairHover";
import { SubPanelHeader } from "./SubPanelHeader";

interface MACDPanelProps {
    data: MACDResult;
    mainChart: IChartApi | null;
    height?: number;
}

export function MACDPanel({ data, mainChart, height: externalHeight }: MACDPanelProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const macdSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const signalSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const histSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
    const [collapsed, setCollapsed] = useState(true);
    const [hovered, setHovered] = useState<{ macd: number; signal: number; hist: number } | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            height: 100,
            layout: { background: { color: "#0a0a0a" }, textColor: "#555", fontSize: 9 },
            grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,0.04)" } },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
            timeScale: { visible: false },
            crosshair: {
                vertLine: { visible: true, color: "rgba(255,255,255,0.2)", width: 1, labelVisible: false },
                horzLine: { visible: false },
            },
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
        const handler = (range: unknown) => {
            // Guard the empty-chart race: lightweight-charts throws "Value is null"
            // if setVisibleLogicalRange runs before this panel's series has data.
            if (!range || data.macd.length === 0) return;
            const r = range as { from: number; to: number };
            const len = data.macd.length || 750;
            const pad = Math.max(0, r.to - (len - 1));
            sub.timeScale().setVisibleLogicalRange({ from: r.from - pad, to: r.to - pad } as never);
        };
        mainChart.timeScale().subscribeVisibleLogicalRangeChange(handler);
        return () => mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
    }, [mainChart, data.macd.length]);

    // Hover readout: show all three values (macd / signal / hist) at the cursor's
    // time on price-chart hover. The three arrays are index- and time-aligned
    // (computeMACD), so one findIndex resolves all three; the marker projects
    // onto the macd line.
    usePanelCrosshairHover<{ macd: number; signal: number; hist: number }>({
        mainChart,
        getChart: () => chartRef.current,
        getSeries: () => macdSeriesRef.current,
        lookup: (t) => {
            const i = data.macd.findIndex((p) => p.time === t);
            if (i < 0) return null;
            const macd = data.macd[i]!.value;
            const signal = data.signal[i]?.value ?? 0;
            const hist = data.histogram[i]?.value ?? 0;
            return { value: { macd, signal, hist }, price: macd };
        },
        setHovered,
        deps: [data],
    });

    useEffect(() => {
        if (chartRef.current && !collapsed && externalHeight) chartRef.current.applyOptions({ height: externalHeight });
    }, [externalHeight, collapsed]);

    useEffect(() => {
        if (!macdSeriesRef.current || !signalSeriesRef.current || !histSeriesRef.current) return;
        if (data.macd.length === 0) return;
        macdSeriesRef.current.setData(data.macd.map((p) => ({ time: p.time as Time, value: p.value })));
        signalSeriesRef.current.setData(data.signal.map((p) => ({ time: p.time as Time, value: p.value })));
        histSeriesRef.current.setData(data.histogram.map((p) => ({ time: p.time as Time, value: p.value, color: p.value >= 0 ? "#16a34a" : "#dc2626" })));
        // Sync range after data loads
        if (mainChart && chartRef.current) {
            const range = mainChart.timeScale().getVisibleRange();
            if (range) requestAnimationFrame(() => { chartRef.current?.timeScale().setVisibleRange(range); });
        }
    }, [data, mainChart]);

    // Re-sync when panel expands from collapsed
    useEffect(() => {
        if (collapsed || !mainChart || !chartRef.current) return;
        requestAnimationFrame(() => {
            const range = mainChart.timeScale().getVisibleRange();
            if (range) chartRef.current?.timeScale().setVisibleRange(range);
        });
    }, [collapsed, mainChart]);

    const lastMacd = data.macd.length > 0 ? data.macd[data.macd.length - 1]!.value : 0;
    const lastSignal = data.signal.length > 0 ? data.signal[data.signal.length - 1]!.value : 0;
    const lastHist = data.histogram.length > 0 ? data.histogram[data.histogram.length - 1]!.value : 0;
    const shownMacd = hovered?.macd ?? lastMacd;
    const shownSignal = hovered?.signal ?? lastSignal;
    const shownHist = hovered?.hist ?? lastHist;

    return (
        <div>
            <SubPanelHeader collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} label="MACD 12/26/9"
                rightContent={<><span style={{ color: "#3b82f6" }}>{shownMacd.toFixed(2)}</span>{" "}<span style={{ color: "#f97316" }}>{shownSignal.toFixed(2)}</span>{" "}<span style={{ color: shownHist >= 0 ? "#16a34a" : "#dc2626" }}>{shownHist.toFixed(2)}</span></>} />
            <div ref={containerRef} style={{ height: collapsed ? 0 : (externalHeight ?? 100), overflow: "hidden" }} />
        </div>
    );
}
