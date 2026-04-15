import { useEffect, useRef, useState, useCallback } from "react";
import {
    createChart,
    BaselineSeries,
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

/** Convert YYYY-MM-DD → UTC seconds. lightweight-charts accepts UTCTimestamp
 *  (number in seconds) directly and handles arbitrary granularity. The prior
 *  "YYYY-MM-DD as Time" string form collapsed to BusinessDay representation,
 *  which is fragile against any duplicate/unsorted inputs. */
function dateToUnixSec(ymd: string): number {
    return Math.floor(Date.parse(ymd + "T00:00:00Z") / 1000);
}

export function COTPanel({ mainChart: _mainChart, pairSymbol, height: externalHeight }: COTPanelProps) {
    // mainChart is accepted for signature parity with other sub-panels but
    // not time-synced: COT data is weekly, the main chart is intraday.
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);
    const [collapsed, setCollapsed] = useState(true);
    const [weeks, setWeeks] = useState<COTWeek[]>([]);

    const base = (pairSymbol.split("/")[0] ?? "BTC").toUpperCase();
    const supported = base === "BTC";

    useEffect(() => {
        if (!containerRef.current) return;
        const chart = createChart(containerRef.current, {
            height: externalHeight ?? 120,
            layout: { background: { color: "transparent" }, textColor: "#555", fontSize: 9 },
            grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,0.04)" } },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
            timeScale: { visible: false, borderVisible: false },
            crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
        });
        // Single BaselineSeries — splits coloring at zero automatically.
        const series = chart.addSeries(BaselineSeries, {
            baseValue: { type: "price", price: 0 },
            topLineColor: "rgb(0, 255, 100)",
            topFillColor1: "rgba(0, 255, 100, 0.25)",
            topFillColor2: "rgba(0, 255, 100, 0.05)",
            bottomLineColor: "rgb(255, 80, 80)",
            bottomFillColor1: "rgba(255, 80, 80, 0.25)",
            bottomFillColor2: "rgba(255, 80, 80, 0.05)",
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            priceScaleId: "cot",
        });
        // Dashed zero line — always visible regardless of data range.
        series.createPriceLine({
            price: 0,
            color: "rgba(255,255,255,0.35)",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: false,
        });

        chartRef.current = chart;
        seriesRef.current = series;
        return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; };
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

    // Feed the baseline series. Defensive pipeline: convert date → unix sec,
    // sort ascending, dedupe by time (keep last occurrence). lightweight-charts
    // requires unique, strictly-ascending time values.
    useEffect(() => {
        const series = seriesRef.current;
        if (!series) return;
        if (weeks.length === 0) { series.setData([]); return; }

        const byTime = new Map<number, number>();
        for (const w of weeks) {
            const t = dateToUnixSec(w.date);
            if (!Number.isFinite(t)) continue;
            byTime.set(t, w.netPosition); // later occurrences overwrite earlier
        }
        const points = Array.from(byTime.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([time, value]) => ({ time: time as Time, value }));

        series.setData(points);
        chartRef.current?.timeScale().fitContent();
    }, [weeks]);

    const latest = weeks.length > 0 ? weeks[weeks.length - 1] : null;
    const net = latest?.netPosition ?? 0;
    const netColor = net >= 0 ? "rgb(0, 255, 100)" : "rgb(255, 80, 80)";
    const netLabel = latest
        ? `Institutional Net: ${formatNet(net)} contracts (${net >= 0 ? "NET LONG" : "NET SHORT"})`
        : "Institutional Net: —";

    return (
        <div style={{ position: "relative" }}>
            <SubPanelHeader
                collapsed={collapsed}
                onToggle={() => setCollapsed((v) => !v)}
                label="COT REPORT"
                rightContent={<span style={{ color: netColor }}>{netLabel}</span>}
            />
            <div ref={containerRef} style={{ height: collapsed ? 0 : (externalHeight ?? 120), overflow: "hidden" }} />
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
