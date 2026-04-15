import { useEffect, useRef } from "react";
import {
    createChart,
    LineSeries,
    LineStyle,
    type IChartApi,
    type ISeriesApi,
    type Time,
} from "lightweight-charts";
import type { CycleAnalog } from "@/api/endpoints/marketData";

interface Props {
    analog: CycleAnalog;
    accentColor: string;
}

const DAY_BASE_UNIX = 946684800;
const dayToTime = (d: number): Time => (DAY_BASE_UNIX + d * 86400) as Time;

function fmtPct(v: number): string {
    const sign = v >= 0 ? "+" : "";
    return `${sign}${v.toFixed(1)}%`;
}

function fmtPrice(v: number): string {
    return "$" + Math.round(v).toLocaleString();
}

export function AnalogMiniCard({ analog, accentColor }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const historicalRef = useRef<ISeriesApi<"Line"> | null>(null);
    const forwardRef = useRef<ISeriesApi<"Line"> | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;
        const chart = createChart(containerRef.current, {
            height: 110,
            layout: { background: { color: "transparent" }, textColor: "rgba(254,243,199,0.35)", fontSize: 8 },
            grid: { vertLines: { visible: false }, horzLines: { visible: false } },
            rightPriceScale: { visible: false },
            leftPriceScale: { visible: false },
            timeScale: { visible: false, borderVisible: false },
            crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
        });

        const hist = chart.addSeries(LineSeries, {
            color: accentColor, lineWidth: 2,
            priceLineVisible: false, lastValueVisible: false,
        });
        const fwd = chart.addSeries(LineSeries, {
            color: accentColor, lineWidth: 2, lineStyle: LineStyle.Dashed,
            priceLineVisible: false, lastValueVisible: false,
        });

        chartRef.current = chart;
        historicalRef.current = hist;
        forwardRef.current = fwd;
        return () => { chart.remove(); chartRef.current = null; };
    }, [accentColor]);

    useEffect(() => {
        const hist = historicalRef.current;
        const fwd = forwardRef.current;
        if (!hist || !fwd) return;

        const baseline = analog.historicalPrices[0];
        if (!baseline || baseline <= 0) return;

        hist.setData(analog.historicalPrices.map((p, i) => ({
            time: dayToTime(-89 + i),
            value: ((p - baseline) / baseline) * 100,
        })));
        fwd.setData(analog.forwardPrices.map((p, i) => ({
            time: dayToTime(i),
            value: ((p - baseline) / baseline) * 100,
        })));
        chartRef.current?.timeScale().fitContent();
    }, [analog]);

    return (
        <div style={{
            border: "1px solid rgba(245,158,11,0.25)", background: "rgba(26,21,0,0.5)",
            padding: 14, fontFamily: "'Space Mono', monospace", color: "#FEF3C7",
        }}>
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                <div style={{ fontSize: 13, letterSpacing: 2, color: accentColor, fontWeight: 700 }}>
                    {analog.date.toUpperCase()}
                </div>
                <div style={{
                    fontSize: 10, padding: "2px 8px", border: `1px solid ${accentColor}`,
                    color: accentColor, letterSpacing: 1.5,
                }}>
                    {analog.similarityScore}% MATCH
                </div>
            </div>
            <div style={{ fontSize: 9, color: "rgba(254,243,199,0.5)", letterSpacing: 1.5 }}>
                BTC {fmtPrice(analog.priceAtTime)} · CYCLE DAY {analog.cycleDay}
            </div>

            {/* Mini chart */}
            <div ref={containerRef} style={{ marginTop: 10, height: 110, borderTop: "1px solid rgba(245,158,11,0.08)", borderBottom: "1px solid rgba(245,158,11,0.08)" }} />

            {/* Outcome table */}
            <div style={{ marginTop: 10, fontSize: 10 }}>
                {(["30d", "90d", "180d"] as const).map((h) => {
                    const change = analog.priceChange[h];
                    const color = change.pct >= 0 ? "#10B981" : "#EF4444";
                    return (
                        <div key={h} style={{
                            display: "flex", justifyContent: "space-between",
                            padding: "3px 0", borderBottom: "1px solid rgba(245,158,11,0.05)",
                        }}>
                            <span style={{ color: "rgba(254,243,199,0.45)", letterSpacing: 1 }}>
                                {h.toUpperCase()}
                            </span>
                            <span>
                                <span style={{ color, fontWeight: 700 }}>{fmtPct(change.pct)}</span>
                                <span style={{ color: "rgba(254,243,199,0.35)", marginLeft: 8 }}>
                                    → {fmtPrice(change.price)}
                                </span>
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
