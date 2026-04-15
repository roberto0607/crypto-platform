import { useState } from "react";
import type { CycleAnalysis, OnChainMetric } from "@/api/endpoints/marketData";

interface Props {
    onChain: CycleAnalysis["onChain"];
}

interface Row {
    key: keyof CycleAnalysis["onChain"];
    label: string;
    fmt: (v: number) => string;
}

const ROWS: Row[] = [
    { key: "mvrv", label: "MVRV RATIO", fmt: (v) => v.toFixed(2) },
    { key: "nupl", label: "NUPL", fmt: (v) => v.toFixed(3) },
    { key: "puellMultiple", label: "PUELL MULTIPLE", fmt: (v) => v.toFixed(2) },
    { key: "reserveRisk", label: "RESERVE RISK", fmt: (v) => v.toFixed(6) },
];

function signalColor(signal: string): string {
    if (signal.includes("BUY")) return "#10B981";
    if (signal === "CAPITULATION" || signal === "HOPE/FEAR") return "#10B981";
    if (signal === "NEUTRAL" || signal === "OPTIMISM") return "#F59E0B";
    if (signal === "CAUTION" || signal === "BELIEF/DENIAL") return "#F59E0B";
    if (signal.includes("SELL") || signal === "EUPHORIA") return "#EF4444";
    return "#92400E";
}

function IndicatorRow({ label, metric, fmt }: { label: string; metric: OnChainMetric; fmt: (v: number) => string }) {
    const [open, setOpen] = useState(false);
    const color = signalColor(metric.signal);

    return (
        <div style={{ borderBottom: "1px solid rgba(245,158,11,0.08)" }}>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                style={{
                    display: "grid", gridTemplateColumns: "20px 1fr 120px 140px", gap: 12,
                    alignItems: "center", width: "100%", textAlign: "left",
                    background: "transparent", border: 0, padding: "12px 4px",
                    cursor: "pointer", color: "#FEF3C7",
                    fontFamily: "'Space Mono', monospace",
                }}
            >
                <span style={{ color: "rgba(254,243,199,0.4)", fontSize: 9 }}>
                    {open ? "▼" : "▶"}
                </span>
                <span style={{ letterSpacing: 2, fontSize: 11 }}>{label}</span>
                <span style={{ color: "#F59E0B", fontSize: 12, letterSpacing: 1 }}>
                    {fmt(metric.value)}
                </span>
                <span style={{
                    fontSize: 9, letterSpacing: 2, padding: "3px 10px",
                    border: `1px solid ${color}`, color, justifySelf: "end",
                }}>
                    {metric.signal}
                </span>
            </button>

            {open && (
                <div style={{ padding: "4px 28px 16px 36px" }}>
                    {/* Percentile bar */}
                    <div style={{
                        position: "relative", height: 6, background: "rgba(245,158,11,0.08)",
                        marginTop: 4, marginBottom: 8,
                    }}>
                        <div style={{
                            position: "absolute", left: 0, top: 0, height: "100%",
                            width: `${Math.max(0, Math.min(100, metric.percentile))}%`,
                            background: color, opacity: 0.75,
                        }} />
                    </div>
                    <div style={{
                        display: "flex", justifyContent: "space-between",
                        fontSize: 9, color: "rgba(254,243,199,0.4)", letterSpacing: 1.5,
                    }}>
                        <span>0%</span>
                        <span>PERCENTILE: {metric.percentile.toFixed(1)}%</span>
                        <span>100%</span>
                    </div>
                    {/* Description */}
                    <div style={{
                        fontSize: 10, color: "rgba(254,243,199,0.55)",
                        marginTop: 10, lineHeight: 1.5,
                    }}>
                        {metric.description}
                    </div>
                    {/* Thresholds */}
                    <div style={{
                        marginTop: 8, fontSize: 9, letterSpacing: 1,
                        color: "rgba(254,243,199,0.35)",
                    }}>
                        Thresholds: {Object.entries(metric.thresholds).map(([k, v]) => `${k}=${v}`).join(" · ")}
                    </div>
                </div>
            )}
        </div>
    );
}

export function OnChainIndicators({ onChain }: Props) {
    return (
        <div style={{
            border: "1px solid rgba(245,158,11,0.2)", background: "rgba(26,21,0,0.35)",
            marginTop: 20,
        }}>
            <div style={{
                padding: "10px 14px", fontSize: 9, letterSpacing: 3, color: "#F59E0B",
                borderBottom: "1px solid rgba(245,158,11,0.15)",
                fontFamily: "'Space Mono', monospace",
            }}>
                ON-CHAIN INDICATORS
            </div>
            {ROWS.map((r) => (
                <IndicatorRow key={r.key} label={r.label} metric={onChain[r.key]} fmt={r.fmt} />
            ))}
        </div>
    );
}
