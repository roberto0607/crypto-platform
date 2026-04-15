import { useMemo } from "react";
import { useCycleData } from "@/hooks/useCycleData";
import { CycleWheel } from "@/components/cycle/CycleWheel";
import { AnalogMainChart } from "@/components/cycle/AnalogMainChart";
import { ConsensusBar } from "@/components/cycle/ConsensusBar";
import { AnalogMiniCard } from "@/components/cycle/AnalogMiniCard";
import { AINarrative } from "@/components/cycle/AINarrative";
import { OnChainIndicators } from "@/components/cycle/OnChainIndicators";

// Gold/amber dedicated theme — injected at page root, following the Arena
// page pattern. Variables scoped to `.cp-wrap` so nothing leaks.
const CYCLE_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap');

  .cp-wrap {
    --cp-bg: #0C0A00;
    --cp-surface: #1A1500;
    --cp-border: #3D2E00;
    --cp-gold: #F59E0B;
    --cp-amber: #D97706;
    --cp-dim: #92400E;
    --cp-text: #FEF3C7;
    --cp-green: #10B981;
    --cp-red: #EF4444;
    --cp-bebas: 'Bebas Neue', sans-serif;
    --cp-mono: 'Space Mono', monospace;
    padding: 18px 24px 28px;
    background: var(--cp-bg);
    color: var(--cp-text);
    font-family: var(--cp-mono);
    min-height: 100%;
    position: relative;
    z-index: 10;
  }

  .cp-header { display:flex; justify-content:space-between; align-items:flex-end; margin-bottom: 20px; }
  .cp-title { font-family: var(--cp-bebas); font-size: 42px; letter-spacing: 7px; color: var(--cp-gold); line-height: 1; }
  .cp-subtitle { font-size: 10px; color: rgba(254,243,199,0.4); letter-spacing: 3px; margin-top: 6px; }
  .cp-meta { font-size: 9px; color: rgba(254,243,199,0.35); letter-spacing: 2px; text-align: right; }

  .cp-grid {
    display: grid; grid-template-columns: 380px 1fr; gap: 24px;
  }
  @media (max-width: 1024px) {
    .cp-grid { grid-template-columns: 1fr; }
  }

  .cp-card {
    border: 1px solid rgba(245,158,11,0.2);
    background: rgba(26,21,0,0.5);
    padding: 16px;
  }

  .cp-stat-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 14px;
  }
  .cp-stat-lbl { font-size: 8px; color: rgba(254,243,199,0.4); letter-spacing: 2px; }
  .cp-stat-val { font-size: 16px; color: var(--cp-gold); font-weight: 700; margin-top: 2px; letter-spacing: 1px; }

  .cp-analogs-row {
    display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-top: 16px;
  }
  @media (max-width: 900px) {
    .cp-analogs-row { grid-template-columns: 1fr; }
  }

  .cp-disclaimer {
    margin-top: 18px; padding: 10px 14px;
    border: 1px dashed rgba(245,158,11,0.2);
    font-size: 9px; letter-spacing: 1; line-height: 1.6;
    color: rgba(254,243,199,0.4);
  }

  .cp-skeleton {
    background: rgba(245,158,11,0.08);
    animation: cp-pulse 1.5s ease-in-out infinite;
  }
  @keyframes cp-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 0.9; } }
`;

const ANALOG_ACCENTS = [
    "rgba(245, 158, 11, 0.9)",  // #F59E0B
    "rgba(217, 119, 6, 0.8)",   // #D97706
    "rgba(146, 64, 14, 0.75)",  // #92400E
];

function fmtPrice(v: number): string {
    return "$" + Math.round(v).toLocaleString();
}

function timeAgo(iso: string): string {
    const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
}

function LoadingState({ message }: { message: string }) {
    return (
        <div className="cp-wrap">
            <style>{CYCLE_CSS}</style>
            <div className="cp-header">
                <div>
                    <div className="cp-title">CYCLE INTELLIGENCE</div>
                    <div className="cp-subtitle">BITCOIN CYCLE ANALYSIS</div>
                </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div className="cp-skeleton" style={{ height: 300 }} />
                <div className="cp-skeleton" style={{ height: 80 }} />
                <div className="cp-skeleton" style={{ height: 180 }} />
            </div>
            <div style={{ textAlign: "center", fontSize: 10, letterSpacing: 2, marginTop: 20, color: "rgba(254,243,199,0.5)" }}>
                {message}
            </div>
        </div>
    );
}

function ErrorState({ message }: { message: string }) {
    return (
        <div className="cp-wrap">
            <style>{CYCLE_CSS}</style>
            <div className="cp-header">
                <div>
                    <div className="cp-title">CYCLE INTELLIGENCE</div>
                    <div className="cp-subtitle">BITCOIN CYCLE ANALYSIS</div>
                </div>
            </div>
            <div style={{
                border: "1px solid rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.06)",
                padding: "20px 24px", fontSize: 12, letterSpacing: 1, color: "#FEF3C7",
            }}>
                {message}
            </div>
        </div>
    );
}

export default function CyclePage() {
    const { data, loading, error, upstreamLoading } = useCycleData();

    const content = useMemo(() => {
        if (loading && !data) {
            return <LoadingState message="Loading cycle analysis..." />;
        }
        if (upstreamLoading) {
            return <LoadingState message="Cycle engine loading historical data — this may take up to 60 seconds on first boot..." />;
        }
        if (error) {
            return <ErrorState message={error} />;
        }
        if (!data) {
            return <LoadingState message="Loading cycle analysis..." />;
        }

        const { cyclePosition, powerLaw, currentWindow, analogs, consensus, onChain, lastUpdated, currentPrice, disclaimer } = data;

        return (
            <div className="cp-wrap">
                <style>{CYCLE_CSS}</style>

                {/* Header */}
                <div className="cp-header">
                    <div>
                        <div className="cp-title">CYCLE INTELLIGENCE</div>
                        <div className="cp-subtitle">BITCOIN CYCLE ANALYSIS</div>
                    </div>
                    <div className="cp-meta">
                        BTC {fmtPrice(currentPrice)}<br />
                        UPDATED {timeAgo(lastUpdated).toUpperCase()}
                    </div>
                </div>

                {/* Top row: wheel + stats (left) + main chart (right) */}
                <div className="cp-grid">
                    <div>
                        <div className="cp-card">
                            <CycleWheel cyclePosition={cyclePosition} />
                        </div>
                        <div className="cp-stat-grid">
                            <div className="cp-card">
                                <div className="cp-stat-lbl">CYCLE %</div>
                                <div className="cp-stat-val">{cyclePosition.cyclePercent}%</div>
                            </div>
                            <div className="cp-card">
                                <div className="cp-stat-lbl">DAYS TO NEXT HALVING</div>
                                <div className="cp-stat-val">{cyclePosition.daysToNextHalving}</div>
                            </div>
                            <div className="cp-card">
                                <div className="cp-stat-lbl">POWER LAW</div>
                                <div className="cp-stat-val">{powerLaw.interpretation}</div>
                                <div style={{ fontSize: 10, color: "rgba(254,243,199,0.45)", marginTop: 3 }}>
                                    {powerLaw.corridorPercent}% of corridor · fair {fmtPrice(powerLaw.fairValue)}
                                </div>
                            </div>
                            <div className="cp-card">
                                <div className="cp-stat-lbl">PL FLOOR / CEILING</div>
                                <div style={{ fontSize: 11, color: "#FEF3C7", marginTop: 4 }}>
                                    {fmtPrice(powerLaw.floorValue)} — {fmtPrice(powerLaw.ceilingValue)}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div>
                        <div className="cp-card" style={{ padding: 0 }}>
                            <AnalogMainChart
                                currentPrices={currentWindow?.prices ?? []}
                                analogs={analogs}
                            />
                        </div>
                        <ConsensusBar consensus={consensus} analogCount={analogs.length} />
                    </div>
                </div>

                {/* AI narrative — full width */}
                <AINarrative cycleData={data} />

                {/* Analog cards — 3 across */}
                {analogs.length > 0 && (
                    <div className="cp-analogs-row">
                        {analogs.map((a, i) => (
                            <AnalogMiniCard
                                key={a.startDate}
                                analog={a}
                                accentColor={ANALOG_ACCENTS[i] ?? "rgba(146, 64, 14, 0.75)"}
                            />
                        ))}
                    </div>
                )}

                {/* On-chain indicators (collapsed by default) */}
                <OnChainIndicators onChain={onChain} />

                {/* Disclaimer */}
                <div className="cp-disclaimer">{disclaimer}</div>
            </div>
        );
    }, [data, loading, error, upstreamLoading]);

    return content;
}
