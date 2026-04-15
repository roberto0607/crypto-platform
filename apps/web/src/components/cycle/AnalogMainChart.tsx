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

interface AnalogMainChartProps {
    currentPrices: number[];
    analogs: CycleAnalog[];
    height?: number;
}

// Day-offset → synthetic UTCTimestamp (unix seconds). We can't use real dates
// because we're overlaying series from different years (2017 vs now) on the
// same relative timeline. 2000-01-01 gives us plenty of negative-offset room.
const DAY_BASE_UNIX = 946684800;
const dayToTime = (d: number): Time => (DAY_BASE_UNIX + d * 86400) as Time;

/** Convert a price array into % returns from prices[0], starting at `startDay`. */
function toPctSeries(
    prices: number[],
    startDay: number,
): Array<{ time: Time; value: number }> {
    const base = prices[0];
    if (base === undefined || base <= 0) return [];
    return prices.map((p, i) => ({
        time: dayToTime(startDay + i),
        value: ((p - base) / base) * 100,
    }));
}

// 3-tier amber opacity per spec
const ANALOG_STYLES = [
    { color: "rgba(245, 158, 11, 0.85)", opacity: 0.6 },  // #F59E0B
    { color: "rgba(217, 119, 6, 0.7)",   opacity: 0.4 },  // #D97706
    { color: "rgba(146, 64, 14, 0.6)",   opacity: 0.25 }, // #92400E
];

export function AnalogMainChart({ currentPrices, analogs, height = 380 }: AnalogMainChartProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRefs = useRef<ISeriesApi<"Line">[]>([]);

    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            height,
            layout: { background: { color: "transparent" }, textColor: "#92400E", fontSize: 10 },
            grid: {
                vertLines: { color: "rgba(245,158,11,0.06)" },
                horzLines: { color: "rgba(245,158,11,0.06)" },
            },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.15 } },
            timeScale: { visible: true, borderVisible: false, timeVisible: false, secondsVisible: false },
            crosshair: {
                vertLine: { color: "rgba(245,158,11,0.35)", labelVisible: false },
                horzLine: { color: "rgba(245,158,11,0.35)", labelVisible: true },
            },
        });

        chartRef.current = chart;

        // Zero-line guide for % returns
        const zeroSeries = chart.addSeries(LineSeries, {
            color: "rgba(245,158,11,0.2)",
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            priceLineVisible: false,
            lastValueVisible: false,
        });
        zeroSeries.setData([
            { time: dayToTime(-90), value: 0 },
            { time: dayToTime(180), value: 0 },
        ]);

        return () => {
            chart.remove();
            chartRef.current = null;
            seriesRefs.current = [];
        };
    }, [height]);

    // Rebuild data series whenever inputs change (don't recreate chart)
    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;

        // Remove any prior non-zero-line series
        for (const s of seriesRefs.current) {
            try { chart.removeSeries(s); } catch { /* already gone */ }
        }
        seriesRefs.current = [];

        // Analog historical (solid) + forward (dashed) — back-to-front so the
        // higher-opacity ones render on top.
        const fallbackStyle = ANALOG_STYLES[ANALOG_STYLES.length - 1] ?? { color: "rgba(146, 64, 14, 0.6)", opacity: 0.25 };
        for (let i = analogs.length - 1; i >= 0; i--) {
            const analog = analogs[i];
            if (!analog) continue;
            const style = ANALOG_STYLES[i] ?? fallbackStyle;
            const baseline = analog.historicalPrices[0];
            if (baseline === undefined || baseline <= 0) continue;

            // Historical: days -89..0 (90 points)
            const histData = analog.historicalPrices.map((p, idx) => ({
                time: dayToTime(-89 + idx),
                value: ((p - baseline) / baseline) * 100,
            }));
            const histSeries = chart.addSeries(LineSeries, {
                color: style.color,
                lineWidth: 2,
                priceLineVisible: false,
                lastValueVisible: false,
            });
            histSeries.setData(histData);
            seriesRefs.current.push(histSeries);

            // Forward: days 0..180 (181 points), dashed
            const fwdData = analog.forwardPrices.map((p, idx) => ({
                time: dayToTime(idx),
                value: ((p - baseline) / baseline) * 100,
            }));
            const fwdSeries = chart.addSeries(LineSeries, {
                color: style.color,
                lineWidth: 2,
                lineStyle: LineStyle.Dashed,
                priceLineVisible: false,
                lastValueVisible: false,
            });
            fwdSeries.setData(fwdData);
            seriesRefs.current.push(fwdSeries);
        }

        // Current series (white/cream, on top) — days -89..0
        if (currentPrices.length > 0) {
            const currentSeries = chart.addSeries(LineSeries, {
                color: "#FEF3C7",
                lineWidth: 3,
                priceLineVisible: false,
                lastValueVisible: false,
            });
            currentSeries.setData(toPctSeries(currentPrices, -90 + (90 - currentPrices.length) + 1));
            seriesRefs.current.push(currentSeries);
        }

        chart.timeScale().fitContent();
    }, [currentPrices, analogs]);

    return (
        <div style={{ position: "relative", width: "100%" }}>
            <div ref={containerRef} style={{ width: "100%", height }} />
            {/* Legend overlay */}
            <div style={{
                position: "absolute", top: 10, left: 14,
                fontFamily: "'Space Mono', monospace", fontSize: 9, letterSpacing: 1.5,
                background: "rgba(12,10,0,0.85)", border: "1px solid rgba(245,158,11,0.2)",
                padding: "6px 10px", pointerEvents: "none",
            }}>
                <div style={{ color: "#FEF3C7", marginBottom: 4 }}>
                    <span style={{ display: "inline-block", width: 16, height: 2, background: "#FEF3C7", marginRight: 6, verticalAlign: "middle" }} />
                    CURRENT
                </div>
                {analogs.map((a, i) => {
                    const fallback = ANALOG_STYLES[ANALOG_STYLES.length - 1] ?? { color: "rgba(146,64,14,0.6)", opacity: 0.25 };
                    const style = ANALOG_STYLES[i] ?? fallback;
                    return (
                        <div key={a.startDate} style={{ color: style.color, marginBottom: 2 }}>
                            <span style={{
                                display: "inline-block", width: 16, height: 2,
                                background: style.color, marginRight: 6, verticalAlign: "middle",
                            }} />
                            {a.date.toUpperCase()} · {a.similarityScore}% MATCH
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
