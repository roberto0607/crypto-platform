import { useState, useEffect } from "react";
import type { Match } from "@/api/endpoints/matches";

function formatPnl(pct: string | null): string {
    if (!pct) return "0.00%";
    const n = parseFloat(pct);
    return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

function formatCountdown(endsAt: string): string {
    const diff = new Date(endsAt).getTime() - Date.now();
    if (diff <= 0) return "0m 0s";
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    const mins = Math.floor((diff % 3_600_000) / 60_000);
    const secs = Math.floor((diff % 60_000) / 1_000);
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m ${secs}s`;
}

interface MatchHeaderBarProps {
    match: Match;
    yourPnl: string | null;
    opponentPnl: string | null;
    yourName: string;
    opponentName: string;
    onForfeit: () => void;
}

export function MatchHeaderBar({
    match,
    yourPnl,
    opponentPnl,
    yourName,
    opponentName,
    onForfeit,
}: MatchHeaderBarProps) {
    const [timeLeft, setTimeLeft] = useState(match.ends_at ? formatCountdown(match.ends_at) : "--");
    const [showForfeitConfirm, setShowForfeitConfirm] = useState(false);

    // Countdown timer — tick every second
    useEffect(() => {
        if (!match.ends_at) return;
        const tick = () => setTimeLeft(formatCountdown(match.ends_at!));
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [match.ends_at]);

    const yourPnlNum = parseFloat(yourPnl ?? "0");
    const oppPnlNum = parseFloat(opponentPnl ?? "0");
    const youWinning = yourPnlNum >= oppPnlNum;

    const timeMs = match.ends_at ? new Date(match.ends_at).getTime() - Date.now() : Infinity;
    const isUrgent = timeMs < 30 * 60 * 1000 && timeMs > 0;

    return (
        <>
            <div className="lmv-header">
                {/* Left — your score */}
                <div className="lmv-h-left">
                    <span className="lmv-h-name" style={{ color: "var(--ar-orange)" }}>{yourName}</span>
                    <span
                        className="lmv-h-pnl"
                        style={{
                            color: yourPnlNum >= 0 ? "var(--ar-g)" : "var(--ar-red)",
                            background: youWinning ? "rgba(0,255,65,0.06)" : "rgba(204,0,0,0.06)",
                        }}
                    >
                        {formatPnl(yourPnl)}
                    </span>
                </div>

                {/* Center — VS + badge + timer */}
                <div className="lmv-h-center">
                    <span className="lmv-h-vs">VS</span>
                    <span className="lmv-h-badge">1V1 LIVE</span>
                    <span className={`lmv-h-timer${isUrgent ? " urgent" : ""}`}>
                        TIME LEFT: {timeLeft}
                    </span>
                </div>

                {/* Right — opponent score + forfeit */}
                <div className="lmv-h-right">
                    <span className="lmv-h-name" style={{ color: "rgba(255,255,255,0.6)" }}>{opponentName}</span>
                    <span
                        className="lmv-h-pnl"
                        style={{
                            color: oppPnlNum >= 0 ? "var(--ar-g)" : "var(--ar-red)",
                            background: !youWinning ? "rgba(0,255,65,0.06)" : "rgba(204,0,0,0.06)",
                        }}
                    >
                        {formatPnl(opponentPnl)}
                    </span>
                    <button className="lmv-forfeit-btn" onClick={() => setShowForfeitConfirm(true)}>
                        FORFEIT
                    </button>
                </div>
            </div>

            {/* Forfeit confirmation modal */}
            {showForfeitConfirm && (
                <div className="lmv-modal-backdrop" onClick={() => setShowForfeitConfirm(false)}>
                    <div className="lmv-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="lmv-modal-title">FORFEIT MATCH?</div>
                        <p className="lmv-modal-text">
                            Are you sure you want to forfeit this match?
                            You will lose ELO and the match will be recorded as a loss.
                        </p>
                        <div className="lmv-modal-actions">
                            <button className="ar-btn ar-btn-outline" onClick={() => setShowForfeitConfirm(false)}>
                                CANCEL
                            </button>
                            <button
                                className="ar-btn ar-btn-red"
                                onClick={() => {
                                    setShowForfeitConfirm(false);
                                    onForfeit();
                                }}
                            >
                                CONFIRM FORFEIT
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
