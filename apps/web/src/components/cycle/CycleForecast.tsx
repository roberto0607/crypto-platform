import { useEffect, useRef } from "react";
import {
    createChart,
    LineSeries,
    LineStyle,
    createSeriesMarkers,
    type IChartApi,
    type Time,
    type SeriesMarker,
} from "lightweight-charts";
import type { CycleForecast as Forecast, InflectionPoint } from "@/api/endpoints/marketData";

interface Props {
    data: Forecast;
    /** Current observed BTC price — used to anchor the historical line */
    currentPrice: number;
    /** Current date ISO — for the "TODAY" marker */
    todayIso: string;
}

// ── Formatters ──

function fmtPrice(v: number): string {
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return "$" + (Math.round(v / 100) / 10).toFixed(1) + "K";
    return "$" + Math.round(v).toLocaleString();
}

function fmtPriceExact(v: number): string {
    return "$" + Math.round(v).toLocaleString();
}

function fmtDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function fmtMonthYear(iso: string): string {
    return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short" });
}

function fmtPct(v: number): string {
    const sign = v >= 0 ? "+" : "";
    return `${sign}${v.toFixed(1)}%`;
}

function isoToTime(iso: string): Time {
    return Math.floor(new Date(iso).getTime() / 1000) as Time;
}

// ── Stat card ──

function StatCard({
    icon, label, price, subtitle, accent, extras,
}: {
    icon: string;
    label: string;
    price: string;
    subtitle: string;
    accent: string;
    extras?: React.ReactNode;
}) {
    return (
        <div style={{
            border: `1px solid ${accent}`,
            background: `linear-gradient(180deg, ${accent}08 0%, transparent 100%)`,
            padding: "16px 18px",
            fontFamily: "'Space Mono', monospace",
        }}>
            <div style={{ fontSize: 10, letterSpacing: 3, color: accent, marginBottom: 8 }}>
                <span style={{ marginRight: 6 }}>{icon}</span>{label}
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#FEF3C7", letterSpacing: 1, lineHeight: 1.1 }}>
                {price}
            </div>
            <div style={{ fontSize: 11, color: "rgba(254,243,199,0.55)", marginTop: 4, letterSpacing: 1 }}>
                {subtitle}
            </div>
            {extras && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${accent}22`, fontSize: 10, color: "rgba(254,243,199,0.6)", letterSpacing: 1 }}>
                    {extras}
                </div>
            )}
        </div>
    );
}

// ── Timeline chart ──

function TimelineChart({
    data, currentPrice, todayIso,
}: {
    data: Forecast;
    currentPrice: number;
    todayIso: string;
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            height: 340,
            layout: { background: { color: "transparent" }, textColor: "#92400E", fontSize: 10 },
            grid: {
                vertLines: { color: "rgba(245,158,11,0.06)" },
                horzLines: { color: "rgba(245,158,11,0.06)" },
            },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
            timeScale: { visible: true, borderVisible: false, timeVisible: false, secondsVisible: false },
            crosshair: {
                vertLine: { color: "rgba(245,158,11,0.35)", labelVisible: false },
                horzLine: { color: "rgba(245,158,11,0.35)", labelVisible: true },
            },
        });
        chartRef.current = chart;

        const cycleTopTime = isoToTime(data.cycleTop.date);
        const todayTime = isoToTime(todayIso);
        const bottomTime = isoToTime(data.estimatedBottom.date);
        const nextTopTime = isoToTime(data.nextCycleTop.date);

        // ── Historical: cycle top → today (solid white) ──
        const histSeries = chart.addSeries(LineSeries, {
            color: "#FEF3C7", lineWidth: 3,
            priceLineVisible: false, lastValueVisible: false,
        });
        histSeries.setData([
            { time: cycleTopTime, value: data.cycleTop.price },
            { time: todayTime,    value: currentPrice },
        ]);

        // ── Forecast: today → estimated bottom (dashed red) ──
        // Build a smooth path that passes through inflection points.
        const downPath: Array<{ time: Time; value: number }> = [
            { time: todayTime, value: currentPrice },
        ];
        for (const p of data.inflectionPoints) {
            if (p.type === "RALLY" || p.type === "PULLBACK" || p.type === "BOTTOM") {
                downPath.push({ time: isoToTime(p.date), value: p.price });
            }
        }
        // Ensure bottom is the terminus
        if (downPath[downPath.length - 1]?.value !== data.estimatedBottom.price) {
            downPath.push({ time: bottomTime, value: data.estimatedBottom.price });
        }
        // Keep strictly ascending time (lightweight-charts requirement)
        const downPathDedup = dedupeAscending(downPath);
        const downSeries = chart.addSeries(LineSeries, {
            color: "rgba(239,68,68,0.9)", lineWidth: 2, lineStyle: LineStyle.Dashed,
            priceLineVisible: false, lastValueVisible: false,
        });
        downSeries.setData(downPathDedup);

        // ── Forecast: bottom → next top (dashed green) ──
        const upPath = dedupeAscending([
            { time: bottomTime,  value: data.estimatedBottom.price },
            { time: nextTopTime, value: data.nextCycleTop.price },
        ]);
        const upSeries = chart.addSeries(LineSeries, {
            color: "rgba(16,185,129,0.9)", lineWidth: 2, lineStyle: LineStyle.Dashed,
            priceLineVisible: false, lastValueVisible: false,
        });
        upSeries.setData(upPath);

        // ── Markers on the historical series: cycle top + TODAY ──
        const histMarkers: SeriesMarker<Time>[] = [
            {
                time: cycleTopTime,
                position: "aboveBar",
                color: "#F59E0B",
                shape: "circle",
                text: `CYCLE TOP ${fmtPrice(data.cycleTop.price)}`,
            },
            {
                time: todayTime,
                position: "belowBar",
                color: "#FEF3C7",
                shape: "circle",
                text: "TODAY",
            },
        ];
        createSeriesMarkers(histSeries, histMarkers);

        // ── Markers on the down path: inflections + bottom ──
        const downMarkers: SeriesMarker<Time>[] = [];
        for (const p of data.inflectionPoints) {
            if (p.type === "RALLY") {
                downMarkers.push({
                    time: isoToTime(p.date),
                    position: "aboveBar",
                    color: "#10B981",
                    shape: "arrowUp",
                    text: `RELIEF ${fmtPrice(p.price)}`,
                });
            } else if (p.type === "PULLBACK") {
                downMarkers.push({
                    time: isoToTime(p.date),
                    position: "belowBar",
                    color: "#EF4444",
                    shape: "arrowDown",
                    text: `PULL ${fmtPrice(p.price)}`,
                });
            } else if (p.type === "BOTTOM") {
                downMarkers.push({
                    time: isoToTime(p.date),
                    position: "belowBar",
                    color: "#EF4444",
                    shape: "circle",
                    text: `EST. BOTTOM ${fmtPrice(p.price)} · ${fmtMonthYear(p.date)}`,
                });
            }
        }
        if (downMarkers.length > 0) createSeriesMarkers(downSeries, downMarkers);

        // ── Marker on the up path: next cycle top ──
        createSeriesMarkers(upSeries, [{
            time: nextTopTime,
            position: "aboveBar",
            color: "#10B981",
            shape: "circle",
            text: `EST. TOP ${fmtPrice(data.nextCycleTop.price)} · ${fmtMonthYear(data.nextCycleTop.date)}`,
        }]);

        chart.timeScale().fitContent();

        return () => {
            chart.remove();
            chartRef.current = null;
        };
    }, [data, currentPrice, todayIso]);

    return (
        <div style={{
            border: "1px solid rgba(245,158,11,0.2)", background: "rgba(26,21,0,0.35)",
            padding: "10px 6px 6px 6px", marginTop: 16,
        }}>
            <div style={{ fontSize: 9, letterSpacing: 3, color: "#F59E0B", padding: "4px 12px 8px" }}>
                FORECAST TIMELINE (HISTORICAL + PROJECTED)
            </div>
            <div ref={containerRef} style={{ width: "100%", height: 340 }} />
        </div>
    );
}

// Ensure strictly ascending, unique times (lightweight-charts contract)
function dedupeAscending(
    points: Array<{ time: Time; value: number }>,
): Array<{ time: Time; value: number }> {
    const byTime = new Map<number, number>();
    for (const p of points) {
        byTime.set(p.time as unknown as number, p.value);
    }
    return Array.from(byTime.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([t, v]) => ({ time: t as Time, value: v }));
}

// ── Inflection table ──

function InflectionTable({ points }: { points: InflectionPoint[] }) {
    return (
        <div style={{
            border: "1px solid rgba(245,158,11,0.2)", background: "rgba(26,21,0,0.5)",
            marginTop: 16, fontFamily: "'Space Mono', monospace",
        }}>
            <div style={{
                padding: "10px 14px", fontSize: 9, letterSpacing: 3, color: "#F59E0B",
                borderBottom: "1px solid rgba(245,158,11,0.15)",
            }}>
                KEY INFLECTION POINTS (BASED ON HISTORICAL ANALOGS)
            </div>
            <div style={{
                display: "grid", gridTemplateColumns: "1fr 1fr 1fr 2fr",
                fontSize: 9, letterSpacing: 2, color: "rgba(254,243,199,0.4)",
                padding: "8px 14px", borderBottom: "1px solid rgba(245,158,11,0.1)",
            }}>
                <span>DATE</span>
                <span>EST PRICE</span>
                <span>EVENT</span>
                <span>MAGNITUDE</span>
            </div>
            {points.map((p, i) => {
                const { bg, icon, label, tone } = rowStyle(p.type);
                return (
                    <div key={`${p.date}-${i}`} style={{
                        display: "grid", gridTemplateColumns: "1fr 1fr 1fr 2fr",
                        fontSize: 11, padding: "10px 14px", color: "#FEF3C7",
                        background: bg,
                        borderBottom: "1px solid rgba(245,158,11,0.05)",
                        alignItems: "center",
                    }}>
                        <span>{fmtMonthYear(p.date)}</span>
                        <span>{fmtPrice(p.price)}</span>
                        <span style={{ color: tone, letterSpacing: 1.5, fontWeight: 700 }}>
                            {icon} {label}
                        </span>
                        <span style={{ color: "rgba(254,243,199,0.75)" }}>
                            {p.description} ({fmtPct(p.magnitude)})
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

function rowStyle(type: InflectionPoint["type"]): {
    bg: string; icon: string; label: string; tone: string;
} {
    switch (type) {
        case "RALLY":
            return { bg: "rgba(16,185,129,0.06)", icon: "↑", label: "RALLY", tone: "#10B981" };
        case "PULLBACK":
            return { bg: "rgba(239,68,68,0.05)", icon: "↓", label: "PULL", tone: "#EF4444" };
        case "BOTTOM":
            return { bg: "rgba(239,68,68,0.12)", icon: "⬇", label: "BOTTOM", tone: "#F87171" };
        case "TOP":
            return { bg: "rgba(16,185,129,0.12)", icon: "⬆", label: "TOP", tone: "#34D399" };
    }
}

// ── Main component ──

export function CycleForecast({ data, currentPrice, todayIso }: Props) {
    const { cycleTop, estimatedBottom, nextCycleTop } = data;

    return (
        <div style={{ marginTop: 24 }}>
            <div style={{
                fontFamily: "'Space Mono', monospace",
                fontSize: 10, letterSpacing: 4, color: "#F59E0B",
                marginBottom: 12, paddingBottom: 8,
                borderBottom: "1px solid rgba(245,158,11,0.2)",
            }}>
                CYCLE FORECAST
            </div>

            {/* ── Section A: key targets ── */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
                <StatCard
                    icon="⬆"
                    label="CYCLE TOP (CONFIRMED)"
                    price={fmtPriceExact(cycleTop.price)}
                    subtitle={fmtDate(cycleTop.date)}
                    accent="#F59E0B"
                    extras="This cycle's observed peak"
                />
                <StatCard
                    icon="⬇"
                    label="ESTIMATED BOTTOM"
                    price={fmtPriceExact(estimatedBottom.price)}
                    subtitle={`~${fmtMonthYear(estimatedBottom.date)}${estimatedBottom.daysRemaining > 0 ? ` · ${estimatedBottom.daysRemaining} DAYS` : ""}`}
                    accent="#EF4444"
                    extras={
                        <>
                            <div>Range: {fmtPrice(estimatedBottom.confidenceRange.low)} – {fmtPrice(estimatedBottom.confidenceRange.high)}</div>
                            <div style={{ color: "#EF4444", marginTop: 2 }}>{fmtPct(estimatedBottom.dropFromTop)} from top</div>
                        </>
                    }
                />
                <StatCard
                    icon="🚀"
                    label="NEXT CYCLE TOP"
                    price={fmtPriceExact(nextCycleTop.price)}
                    subtitle={`~${fmtMonthYear(nextCycleTop.date)}`}
                    accent="#10B981"
                    extras={
                        <>
                            <div>Range: {fmtPrice(nextCycleTop.confidenceRange.low)} – {fmtPrice(nextCycleTop.confidenceRange.high)}</div>
                            <div style={{ color: "#10B981", marginTop: 2 }}>{fmtPct(nextCycleTop.gainFromBottom)} from est. bottom</div>
                        </>
                    }
                />
            </div>

            {/* ── Section B: timeline chart ── */}
            <TimelineChart data={data} currentPrice={currentPrice} todayIso={todayIso} />

            {/* ── Section C: inflection table ── */}
            <InflectionTable points={data.inflectionPoints} />

            {/* ── Prominent disclaimer ── */}
            <div style={{
                marginTop: 18, padding: "14px 18px",
                border: "1px solid rgba(245,158,11,0.35)",
                background: "rgba(245,158,11,0.05)",
                fontFamily: "'Space Mono', monospace",
                fontSize: 10, lineHeight: 1.6, color: "#FEF3C7", letterSpacing: 0.5,
            }}>
                <div style={{ color: "#F59E0B", letterSpacing: 2, marginBottom: 6, fontSize: 10 }}>
                    ⚠ PROBABILISTIC ESTIMATE
                </div>
                These forecasts are derived from 3 historical Bitcoin cycles (2014, 2018, 2022).
                Bitcoin has never repeated a cycle identically. Macroeconomic conditions,
                regulation, and market structure have changed each cycle. Treat these as
                probabilistic ranges informed by history, not guarantees. Not financial advice.
            </div>
        </div>
    );
}
