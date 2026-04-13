import { useEffect, useRef, useState, useCallback } from "react";
import {
    createChart,
    LineSeries,
    LineStyle,
    type IChartApi,
    type ISeriesApi,
    type Time,
} from "lightweight-charts";
import { fetchCOT, type COTWeek } from "@/api/endpoints/marketData";
import { SubPanelHeader } from "./SubPanelHeader";

interface COTPanelProps {
    mainChart: IChartApi | null;
    pairSymbol: string;
    height?: number;
}

function formatNet(v: number): string {
    const sign = v >= 0 ? "+" : "";
    return sign + v.toLocaleString();
}

export function COTPanel({ mainChart: _mainChart, pairSymbol, height: externalHeight }: COTPanelProps) {
    // mainChart is accepted for signature parity with other sub-panels but
    // not time-synced: COT data is weekly, the main chart is intraday.
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const netLongSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const netShortSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const [collapsed, setCollapsed] = useState(true);
    const [weeks, setWeeks] = useState<COTWeek[]>([]);

    const base = (pairSymbol.split("/")[0] ?? "BTC").toUpperCase();
    const supported = base === "BTC";

    useEffect(() => {
        if (!containerRef.current) return;
        const chart = createChart(containerRef.current, {
            height: externalHeight ?? 100,
            layout: { background: { color: "#0a0a0a" }, textColor: "#555", fontSize: 9 },
            grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,0.04)" } },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
            timeScale: { visible: true, borderVisible: false, timeVisible: false, secondsVisible: false },
            crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
        });
        // Split the line into two overlaid series (green for >=0, red for <0)
        // so the color switches at the zero crossing cleanly.
        const netLong = chart.addSeries(LineSeries, {
            color: "#16a34a", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, priceScaleId: "cot",
        });
        const netShort = chart.addSeries(LineSeries, {
            color: "#dc2626", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, priceScaleId: "cot",
        });
        netLong.createPriceLine({ price: 0, color: "rgba(255,255,255,0.35)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });

        chartRef.current = chart;
        netLongSeriesRef.current = netLong;
        netShortSeriesRef.current = netShort;
        return () => { chart.remove(); chartRef.current = null; netLongSeriesRef.current = null; netShortSeriesRef.current = null; };
    }, []);

    useEffect(() => {
        if (chartRef.current && !collapsed && externalHeight) chartRef.current.applyOptions({ height: externalHeight });
    }, [externalHeight, collapsed]);

    const loadData = useCallback(async () => {
        if (!supported) { setWeeks([]); return; }
        try {
            const res = await fetchCOT(base);
            setWeeks(res.data.weeks ?? []);
        } catch { /* non-fatal */ }
    }, [base, supported]);

    useEffect(() => {
        loadData();
        const id = setInterval(loadData, 6 * 60 * 60 * 1000); // match backend cache TTL
        return () => clearInterval(id);
    }, [loadData]);

    // Feed the two overlaid line series. Points with opposite sign are set to
    // the zero line on the "wrong" series so the active color stays accurate.
    useEffect(() => {
        if (!netLongSeriesRef.current || !netShortSeriesRef.current) return;
        if (weeks.length === 0) {
            netLongSeriesRef.current.setData([]);
            netShortSeriesRef.current.setData([]);
            return;
        }
        const longPts = weeks.map((w) => ({
            time: w.date as Time,
            value: w.netPosition >= 0 ? w.netPosition : 0,
        }));
        const shortPts = weeks.map((w) => ({
            time: w.date as Time,
            value: w.netPosition < 0 ? w.netPosition : 0,
        }));
        netLongSeriesRef.current.setData(longPts);
        netShortSeriesRef.current.setData(shortPts);
        chartRef.current?.timeScale().fitContent();
    }, [weeks]);

    const latest = weeks.length > 0 ? weeks[weeks.length - 1] : null;
    const net = latest?.netPosition ?? 0;
    const netLabel = latest
        ? `Institutional Net: ${formatNet(net)} contracts (${net >= 0 ? "NET LONG" : "NET SHORT"})`
        : "Institutional Net: —";

    return (
        <div style={{ position: "relative" }}>
            <SubPanelHeader
                collapsed={collapsed}
                onToggle={() => setCollapsed((v) => !v)}
                label="COT REPORT"
                rightContent={<span style={{ color: net >= 0 ? "#16a34a" : "#dc2626" }}>{netLabel}</span>}
            />
            <div ref={containerRef} style={{ height: collapsed ? 0 : (externalHeight ?? 100), overflow: "hidden" }} />
            {!collapsed && (
                <div style={{
                    position: "absolute", bottom: 2, right: 6, fontSize: 8,
                    color: "rgba(255,255,255,0.3)", letterSpacing: 1, fontFamily: "'Space Mono', monospace",
                    pointerEvents: "none",
                }}>
                    Source: CFTC CME Futures (weekly)
                </div>
            )}
            {!collapsed && !supported && (
                <div style={{
                    position: "absolute", top: 20, left: 0, right: 0, bottom: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "#444", fontSize: 10, letterSpacing: 2, pointerEvents: "none",
                }}>
                    COT data available for BTC only
                </div>
            )}
            {!collapsed && supported && weeks.length === 0 && (
                <div style={{
                    position: "absolute", top: 20, left: 0, right: 0, bottom: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "#444", fontSize: 10, letterSpacing: 2, pointerEvents: "none",
                }}>
                    No historical data
                </div>
            )}
        </div>
    );
}
