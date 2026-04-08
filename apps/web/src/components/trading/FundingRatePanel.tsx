import { useEffect, useRef, useState, useCallback } from "react";
import {
    createChart,
    HistogramSeries,
    LineStyle,
    type IChartApi,
    type ISeriesApi,
    type Time,
} from "lightweight-charts";
import { fetchFundingRate, type FundingRateEntry } from "@/api/endpoints/marketData";
import { SubPanelHeader } from "./SubPanelHeader";

interface FundingRatePanelProps {
    mainChart: IChartApi | null;
    pairSymbol: string;
    height?: number;
}

function symbolToKey(sym: string): "btc" | "eth" | "sol" {
    const base = sym.split("/")[0]?.toLowerCase() ?? "btc";
    return (base === "eth" ? "eth" : base === "sol" ? "sol" : "btc") as "btc" | "eth" | "sol";
}

function formatCountdown(ms: number): string {
    if (ms <= 0) return "now";
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const TZ_OFFSET_SEC = new Date().getTimezoneOffset() * -60;

export function FundingRatePanel({ mainChart, pairSymbol, height: externalHeight }: FundingRatePanelProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
    const [collapsed, setCollapsed] = useState(true);
    const [entry, setEntry] = useState<FundingRateEntry | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;
        const chart = createChart(containerRef.current, {
            height: externalHeight ?? 80,
            layout: { background: { color: "#0a0a0a" }, textColor: "#555", fontSize: 9 },
            grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,0.04)" } },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
            timeScale: { visible: false },
            crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
        });
        const series = chart.addSeries(HistogramSeries, { priceScaleId: "fr", priceLineVisible: false, lastValueVisible: false });
        series.createPriceLine({ price: 0, color: "#444444", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
        chartRef.current = chart;
        seriesRef.current = series;
        return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; };
    }, []);

    // Scroll sync — time-based (external data has different timestamps than main chart candles)
    useEffect(() => {
        if (!mainChart || !chartRef.current) return;
        const sub = chartRef.current;
        const handler = (range: unknown) => { if (range) sub.timeScale().setVisibleRange(range as never); };
        mainChart.timeScale().subscribeVisibleTimeRangeChange(handler);
        return () => mainChart.timeScale().unsubscribeVisibleTimeRangeChange(handler);
    }, [mainChart]);

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
            const res = await fetchFundingRate();
            const key = symbolToKey(pairSymbol);
            setEntry(res.data[key] ?? null);
        } catch { /* non-fatal */ }
    }, [pairSymbol]);

    useEffect(() => {
        loadData();
        const id = setInterval(loadData, 300_000);
        return () => clearInterval(id);
    }, [loadData]);

    // Set chart data from history
    useEffect(() => {
        if (!seriesRef.current || !entry?.history?.length) return;
        seriesRef.current.setData(entry.history.map((p) => ({
            time: (p.time + TZ_OFFSET_SEC) as Time,
            value: p.value,
            color: p.value >= 0 ? "#16a34a" : "#dc2626",
        })));
        if (mainChart && chartRef.current) {
            const range = mainChart.timeScale().getVisibleRange();
            if (range) requestAnimationFrame(() => { chartRef.current?.timeScale().setVisibleRange(range); });
        }
    }, [entry, mainChart]);

    const rate = entry?.rate ?? 0;
    const nextTime = entry?.nextFundingTime ?? 0;
    const countdown = nextTime > 0 ? formatCountdown(nextTime - Date.now()) : "--";
    const rateStr = (rate >= 0 ? "+" : "") + (rate * 100).toFixed(4) + "%";

    return (
        <div>
            <SubPanelHeader collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} label="FUNDING RATE"
                rightContent={<>
                    <span style={{ color: rate >= 0 ? "#16a34a" : "#dc2626" }}>{rateStr}</span>
                    <span style={{ color: "rgba(255,255,255,0.3)", marginLeft: 8 }}>Next: {countdown}</span>
                </>} />
            <div ref={containerRef} style={{ height: collapsed ? 0 : (externalHeight ?? 80), overflow: "hidden" }} />
        </div>
    );
}
