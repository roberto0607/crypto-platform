import type { CycleAnalysis } from "@/api/endpoints/marketData";

interface Props {
    consensus: CycleAnalysis["consensus"];
    analogCount: number;
}

function fmtPct(v: number): string {
    const sign = v >= 0 ? "+" : "";
    return `${sign}${v.toFixed(1)}%`;
}

export function ConsensusBar({ consensus, analogCount }: Props) {
    const horizons: Array<keyof typeof consensus> = ["30d", "90d", "180d"];
    const dominant = consensus["90d"].bullish > consensus["90d"].bearish ? "BULLISH" : "BEARISH";
    const dominantColor = dominant === "BULLISH" ? "#10B981" : "#EF4444";
    const bull90 = consensus["90d"].bullish;

    return (
        <div style={{
            border: "1px solid rgba(245,158,11,0.3)", background: "rgba(245,158,11,0.04)",
            padding: "14px 18px", marginTop: 12,
            fontFamily: "'Space Mono', monospace", color: "#FEF3C7",
        }}>
            <div style={{ fontSize: 9, letterSpacing: 3, color: "#F59E0B", marginBottom: 10 }}>
                CONSENSUS OUTCOME (WEIGHTED BY SIMILARITY)
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18 }}>
                {horizons.map((h) => {
                    const c = consensus[h];
                    const color = c.median >= 0 ? "#10B981" : "#EF4444";
                    return (
                        <div key={h}>
                            <div style={{ fontSize: 8, letterSpacing: 2, color: "rgba(254,243,199,0.4)" }}>
                                {h.toUpperCase()} HORIZON
                            </div>
                            <div style={{ fontSize: 22, color, fontWeight: 700, letterSpacing: 1 }}>
                                {fmtPct(c.median)}
                            </div>
                            <div style={{ fontSize: 9, color: "rgba(254,243,199,0.5)", letterSpacing: 1 }}>
                                Range {fmtPct(c.min)} to {fmtPct(c.max)}
                            </div>
                        </div>
                    );
                })}
            </div>
            <div style={{
                marginTop: 12, paddingTop: 10, borderTop: "1px solid rgba(245,158,11,0.12)",
                fontSize: 10, letterSpacing: 2,
            }}>
                Direction: <span style={{ color: dominantColor, fontWeight: 700 }}>
                    {bull90}/{analogCount} ANALOGS {dominant}
                </span> (90d horizon)
            </div>
        </div>
    );
}
