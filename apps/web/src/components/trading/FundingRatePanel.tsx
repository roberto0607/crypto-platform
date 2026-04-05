import { useEffect, useRef, useState, useCallback } from "react";
import {
    createChart,
    HistogramSeries,
    LineStyle,
    type IChartApi,
    type ISeriesApi,
    type Time,
} from "lightweight-charts";
import { fetchFundingRate, type FundingRateData } from "@/api/endpoints/marketData";
import { SubPanelHeader } from "./SubPanelHeader";

interface FundingRatePanelProps {
    mainChart: IChartApi | null;
    pairSymbol: string; // "BTC/USD" | "ETH/USD" | "SOL/USD"
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

export function FundingRatePanel({ mainChart, pairSymbol, height: externalHeight }: FundingRatePanelProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
    const [collapsed, setCollapsed] = useState(true);
    const [fundingData, setFundingData] = useState<FundingRateData | null>(null);

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

    // Sync scroll
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

    // Expand re-sync
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
            setFundingData(res.data);
        } catch { /* non-fatal */ }
    }, []);

    useEffect(() => {
        loadData();
        const id = setInterval(loadData, 300_000);
        return () => clearInterval(id);
    }, [loadData]);

    // Display single histogram bar for current rate (visual only — no time series available from funding endpoint)
    useEffect(() => {
        if (!seriesRef.current || !fundingData) return;
        const key = symbolToKey(pairSymbol);
        const rate = fundingData[key]?.rate ?? 0;
        const now = Math.floor(Date.now() / 1000) as unknown as Time;
        seriesRef.current.setData([{ time: now, value: rate * 100, color: rate >= 0 ? "#16a34a" : "#dc2626" }]);
    }, [fundingData, pairSymbol]);

    const key = symbolToKey(pairSymbol);
    const rate = fundingData?.[key]?.rate ?? 0;
    const nextTime = fundingData?.[key]?.nextFundingTime ?? 0;
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
