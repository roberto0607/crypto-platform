import { useEffect, useRef, useState, useCallback } from "react";
import {
    createChart,
    LineSeries,
    type IChartApi,
    type ISeriesApi,
    type Time,
} from "lightweight-charts";
import { fetchOpenInterest, type OIHistoryPoint } from "@/api/endpoints/marketData";
import { SubPanelHeader } from "./SubPanelHeader";

interface OpenInterestPanelProps {
    mainChart: IChartApi | null;
    pairSymbol: string;
    height?: number;
}

function symbolToKey(sym: string): "btc" | "eth" | "sol" {
    const base = sym.split("/")[0]?.toLowerCase() ?? "btc";
    return (base === "eth" ? "eth" : base === "sol" ? "sol" : "btc") as "btc" | "eth" | "sol";
}

function formatOI(val: number): string {
    if (val >= 1e12) return "$" + (val / 1e12).toFixed(1) + "T";
    if (val >= 1e9) return "$" + (val / 1e9).toFixed(1) + "B";
    if (val >= 1e6) return "$" + (val / 1e6).toFixed(1) + "M";
    if (val >= 1e3) return "$" + (val / 1e3).toFixed(0) + "K";
    return "$" + val.toFixed(0);
}

const TZ_OFFSET_SEC = new Date().getTimezoneOffset() * -60;

export function OpenInterestPanel({ mainChart, pairSymbol, height: externalHeight }: OpenInterestPanelProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const [collapsed, setCollapsed] = useState(true);
    const [currentOI, setCurrentOI] = useState(0);
    const [history, setHistory] = useState<OIHistoryPoint[]>([]);

    useEffect(() => {
        if (!containerRef.current) return;
        const chart = createChart(containerRef.current, {
            height: externalHeight ?? 100,
            layout: { background: { color: "#0a0a0a" }, textColor: "#555", fontSize: 9 },
            grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,0.04)" } },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
            timeScale: { visible: false },
            crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
        });
        const series = chart.addSeries(LineSeries, { color: "#eab308", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, priceScaleId: "oi" });
        chartRef.current = chart;
        seriesRef.current = series;
        return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; };
    }, []);

    // Sync scroll with offset adjustment
    useEffect(() => {
        if (!mainChart || !chartRef.current) return;
        const sub = chartRef.current;
        const handler = (range: unknown) => {
            if (!range) return;
            const r = range as { from: number; to: number };
            const len = history.length || 200;
            const pad = Math.max(0, r.to - (len - 1));
            sub.timeScale().setVisibleLogicalRange({ from: r.from - pad, to: r.to - pad } as never);
        };
        mainChart.timeScale().subscribeVisibleLogicalRangeChange(handler);
        return () => mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
    }, [mainChart, history.length]);

    useEffect(() => {
        if (chartRef.current && !collapsed && externalHeight) chartRef.current.applyOptions({ height: externalHeight });
    }, [externalHeight, collapsed]);

    useEffect(() => {
        if (collapsed || !mainChart || !chartRef.current) return;
        requestAnimationFrame(() => {
            const range = mainChart.timeScale().getVisibleRange();
            if (range) chartRef.current?.timeScale().setVisibleRange(range);
        });
    }, [collapsed, mainChart]);

    // Fetch data
    const loadData = useCallback(async () => {
        try {
            const res = await fetchOpenInterest();
            const key = symbolToKey(pairSymbol);
            const d = res.data[key];
            if (d) {
                setCurrentOI(d.current);
                setHistory(d.history);
            }
        } catch { /* non-fatal */ }
    }, [pairSymbol]);

    useEffect(() => {
        loadData();
        const id = setInterval(loadData, 300_000);
        return () => clearInterval(id);
    }, [loadData]);

    // Set chart data
    useEffect(() => {
        if (!seriesRef.current || history.length === 0) return;
        seriesRef.current.setData(history.map((p) => ({
            time: (p.time + TZ_OFFSET_SEC) as Time,
            value: p.value,
        })));
        if (mainChart && chartRef.current) {
            const range = mainChart.timeScale().getVisibleRange();
            if (range) requestAnimationFrame(() => { chartRef.current?.timeScale().setVisibleRange(range); });
        }
    }, [history, mainChart]);

    return (
        <div>
            <SubPanelHeader collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} label="OPEN INTEREST"
                rightContent={<span style={{ color: "#eab308" }}>{formatOI(currentOI)}</span>} />
            <div ref={containerRef} style={{ height: collapsed ? 0 : (externalHeight ?? 100), overflow: "hidden" }} />
        </div>
    );
}
