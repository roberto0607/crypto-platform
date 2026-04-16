import { useEffect, useRef } from "react";
import {
    createChart,
    LineSeries,
    LineStyle,
    createSeriesMarkers,
    type IChartApi,
    type Time,
} from "lightweight-charts";
import type {
    CyclePerformanceData,
    CyclePerformanceCycle,
    CyclePerformanceInsight,
} from "@/api/endpoints/marketData";

interface Props {
    data: CyclePerformanceData;
}

function fmtPct(v: number): string {
    const sign = v >= 0 ? "+" : "";
    return `${sign}${v.toFixed(1)}%`;
}

function fmtPrice(v: number): string {
    return "$" + Math.round(v).toLocaleString();
}

function statusColor(status: string): string {
    if (status === "OUTPERFORMING") return "#10B981";
    if (status === "UNDERPERFORMING") return "#EF4444";
    return "#F59E0B";
}

// ── Insight bar ──

function InsightBar({ insight, currentMonth }: { insight: CyclePerformanceInsight; currentMonth: number }) {
    const sc = statusColor(insight.status);
    return (
        <div style={{
            border: "1px solid rgba(245,158,11,0.3)", background: "rgba(245,158,11,0.04)",
            padding: "14px 18px", marginBottom: 14,
            fontFamily: "'Space Mono', monospace", color: "#FEF3C7",
        }}>
            <div style={{ fontSize: 10, letterSpacing: 3, color: "#F59E0B", marginBottom: 10 }}>
                CYCLE PERFORMANCE COMPARISON
            </div>
            <div style={{ fontSize: 11, color: "rgba(254,243,199,0.6)", marginBottom: 10, letterSpacing: 1.5 }}>
                Month {currentMonth} of Current Cycle
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, fontSize: 12 }}>
                {insight.cycle2AtSameMonth !== null && (
                    <div>
                        <div style={{ fontSize: 8, letterSpacing: 2, color: "rgba(254,243,199,0.4)" }}>CYCLE 2 AT MONTH {currentMonth}</div>
                        <div style={{ fontWeight: 700, color: "#6B7280", marginTop: 2 }}>{fmtPct(insight.cycle2AtSameMonth)}</div>
                    </div>
                )}
                {insight.cycle3AtSameMonth !== null && (
                    <div>
                        <div style={{ fontSize: 8, letterSpacing: 2, color: "rgba(254,243,199,0.4)" }}>CYCLE 3 AT MONTH {currentMonth}</div>
                        <div style={{ fontWeight: 700, color: "#D97706", marginTop: 2 }}>{fmtPct(insight.cycle3AtSameMonth)}</div>
                    </div>
                )}
                <div>
                    <div style={{ fontSize: 8, letterSpacing: 2, color: "rgba(254,243,199,0.4)" }}>CURRENT CYCLE</div>
                    <div style={{ fontWeight: 700, color: "#F59E0B", marginTop: 2 }}>
                        {fmtPct(insight.currentReturn)}{" "}
                        <span style={{
                            fontSize: 9, padding: "2px 8px", border: `1px solid ${sc}`,
                            color: sc, letterSpacing: 2, verticalAlign: "middle",
                        }}>
                            {insight.status}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ── Chart ──

// Use month index as a synthetic UTCTimestamp (lightweight-charts needs monotonic numbers).
const MONTH_BASE_UNIX = 946684800; // 2000-01-01
const monthToTime = (m: number): Time => (MONTH_BASE_UNIX + m * 30 * 86400) as Time;

function PerformanceChart({ data }: { data: CyclePerformanceData }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;
        const chart = createChart(containerRef.current, {
            height: 380,
            layout: { background: { color: "transparent" }, textColor: "#92400E", fontSize: 10 },
            grid: {
                vertLines: { color: "rgba(245,158,11,0.06)" },
                horzLines: { color: "rgba(245,158,11,0.06)" },
            },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
            timeScale: { visible: true, borderVisible: false, timeVisible: false, secondsVisible: false },
            crosshair: {
                vertLine: { color: "rgba(245,158,11,0.35)", labelVisible: false },
                horzLine: { color: "rgba(245,158,11,0.35)", labelVisible: true },
            },
        });
        chartRef.current = chart;

        // "YOU ARE HERE" vertical line
        const curMonth = data.currentCycleMonth;
        const markerSeries = chart.addSeries(LineSeries, {
            color: "rgba(245,158,11,0.35)", lineWidth: 1, lineStyle: LineStyle.Dashed,
            priceLineVisible: false, lastValueVisible: false,
        });
        // Find max return across all cycles for the vertical line height
        let maxReturn = 0;
        for (const c of data.cycles) {
            for (const pt of c.data) {
                if (pt.pctReturn > maxReturn) maxReturn = pt.pctReturn;
            }
        }
        markerSeries.setData([
            { time: monthToTime(curMonth), value: 0 },
            { time: monthToTime(curMonth), value: maxReturn > 0 ? maxReturn : 100 },
        ]);
        createSeriesMarkers(markerSeries, [{
            time: monthToTime(curMonth),
            position: "aboveBar",
            color: "#F59E0B",
            shape: "arrowDown",
            text: `YOU ARE HERE — Month ${curMonth}`,
        }]);

        // Cycle lines (back to front so current renders on top)
        const reversed = [...data.cycles].reverse();
        for (const cycle of reversed) {
            if (cycle.data.length === 0) continue;
            const isCurrent = cycle.name.includes("Current");
            const s = chart.addSeries(LineSeries, {
                color: cycle.color,
                lineWidth: isCurrent ? 3 : 2,
                priceLineVisible: false,
                lastValueVisible: false,
            });
            s.setData(cycle.data.map((pt) => ({
                time: monthToTime(pt.month),
                value: pt.pctReturn,
            })));

            // Peak marker for completed cycles
            if (!isCurrent && cycle.peakMonth !== null && cycle.peakReturn !== null) {
                createSeriesMarkers(s, [{
                    time: monthToTime(cycle.peakMonth),
                    position: "aboveBar",
                    color: cycle.color,
                    shape: "circle",
                    text: `PEAK ${fmtPct(cycle.peakReturn)}`,
                }]);
            }
        }

        chart.timeScale().fitContent();

        return () => { chart.remove(); chartRef.current = null; };
    }, [data]);

    return (
        <div style={{ position: "relative", width: "100%" }}>
            <div ref={containerRef} style={{ width: "100%", height: 380 }} />
            {/* Legend */}
            <div style={{
                position: "absolute", top: 10, left: 14,
                fontFamily: "'Space Mono', monospace", fontSize: 9, letterSpacing: 1.5,
                background: "rgba(12,10,0,0.85)", border: "1px solid rgba(245,158,11,0.2)",
                padding: "6px 10px", pointerEvents: "none",
            }}>
                {data.cycles.map((c) => (
                    <div key={c.name} style={{ color: c.color, marginBottom: 2 }}>
                        <span style={{
                            display: "inline-block", width: 16, height: 2,
                            background: c.color, marginRight: 6, verticalAlign: "middle",
                        }} />
                        {c.name.includes("Current") ? "NOW" : c.halvingDate.slice(0, 4)}
                    </div>
                ))}
            </div>
        </div>
    );
}

// ── Monthly table ──

function MonthlyTable({ cycles, currentMonth }: { cycles: CyclePerformanceCycle[]; currentMonth: number }) {
    const maxMonth = Math.max(...cycles.map((c) => c.data.length > 0 ? c.data[c.data.length - 1]?.month ?? 0 : 0));
    const rows: number[] = [];
    for (let m = 0; m <= maxMonth; m++) rows.push(m);

    return (
        <div style={{
            border: "1px solid rgba(245,158,11,0.2)", marginTop: 16,
            maxHeight: 320, overflowY: "auto",
            fontFamily: "'Space Mono', monospace", fontSize: 10,
        }}>
            {/* Header */}
            <div style={{
                display: "grid", gridTemplateColumns: `80px ${cycles.map(() => "1fr").join(" ")}`,
                position: "sticky", top: 0, zIndex: 2,
                background: "#0C0A00", borderBottom: "1px solid rgba(245,158,11,0.15)",
                padding: "8px 10px", fontSize: 9, letterSpacing: 2, color: "rgba(254,243,199,0.4)",
            }}>
                <span>MONTH</span>
                {cycles.map((c) => (
                    <span key={c.name} style={{ color: c.color }}>{c.name.replace("Cycle ", "C").replace(" (Current)", " NOW")}</span>
                ))}
            </div>
            {/* Body */}
            {rows.map((m) => {
                const isCurrent = m === currentMonth;
                return (
                    <div key={m} style={{
                        display: "grid", gridTemplateColumns: `80px ${cycles.map(() => "1fr").join(" ")}`,
                        padding: "6px 10px",
                        background: isCurrent ? "rgba(245,158,11,0.12)" : "transparent",
                        borderBottom: "1px solid rgba(245,158,11,0.05)",
                        color: "#FEF3C7",
                    }}>
                        <span style={{ color: isCurrent ? "#F59E0B" : "rgba(254,243,199,0.5)" }}>
                            {m}
                        </span>
                        {cycles.map((c) => {
                            const pt = c.data.find((p) => p.month === m);
                            if (!pt) return <span key={c.name} style={{ color: "rgba(254,243,199,0.2)" }}>—</span>;
                            const pctColor = pt.pctReturn >= 0 ? "#10B981" : "#EF4444";
                            return (
                                <span key={c.name}>
                                    <span style={{ color: "rgba(254,243,199,0.5)" }}>{fmtPrice(pt.price)}</span>{" "}
                                    <span style={{ color: pctColor }}>{fmtPct(pt.pctReturn)}</span>
                                </span>
                            );
                        })}
                    </div>
                );
            })}
        </div>
    );
}

// ── Main ──

export function CyclePerformance({ data }: Props) {
    return (
        <div style={{ marginTop: 24 }}>
            <div style={{
                fontFamily: "'Space Mono', monospace",
                fontSize: 10, letterSpacing: 4, color: "#F59E0B",
                marginBottom: 12, paddingBottom: 8,
                borderBottom: "1px solid rgba(245,158,11,0.2)",
            }}>
                CYCLE PERFORMANCE COMPARISON
            </div>
            <InsightBar insight={data.insight} currentMonth={data.currentCycleMonth} />
            <div style={{ border: "1px solid rgba(245,158,11,0.2)", background: "rgba(26,21,0,0.35)", padding: "10px 6px 6px 6px" }}>
                <PerformanceChart data={data} />
            </div>
            <MonthlyTable cycles={data.cycles} currentMonth={data.currentCycleMonth} />
        </div>
    );
}
