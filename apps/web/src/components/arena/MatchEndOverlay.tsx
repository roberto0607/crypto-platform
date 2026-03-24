import { useState, useEffect } from "react";
import type { Match } from "@/api/endpoints/matches";
import client from "@/api/client";

function formatPnl(pct: string | null): string {
    if (!pct) return "0.00%";
    const n = parseFloat(pct);
    return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

interface EloResult {
    winner_id: string;
    loser_id: string;
    winner_old_elo: number;
    winner_new_elo: number;
    winner_delta: number;
    loser_old_elo: number;
    loser_new_elo: number;
    loser_delta: number;
    winner_tier_before: string;
    winner_tier_after: string;
    loser_tier_before: string;
    loser_tier_after: string;
    winner_win_streak: number;
    streak_multiplier: string;
    badges_earned: string[];
}

interface MatchEndOverlayProps {
    match: Match;
    userId: string;
    onBackToArena: () => void;
}

export function MatchEndOverlay({ match, userId, onBackToArena }: MatchEndOverlayProps) {
    const [eloResult, setEloResult] = useState<EloResult | null>(null);

    useEffect(() => {
        client
            .get<{ ok: true; result: EloResult }>(`/v1/matches/${match.id}/result`)
            .then((res) => setEloResult(res.data.result))
            .catch(() => {}); // Non-fatal — fall back to basic display
    }, [match.id]);

    const isChallenger = match.challenger_id === userId;
    const yourPnl = isChallenger ? match.challenger_pnl_pct : match.opponent_pnl_pct;
    const oppPnl = isChallenger ? match.opponent_pnl_pct : match.challenger_pnl_pct;
    const won = match.winner_id === userId;
    const lost = match.winner_id != null && match.winner_id !== userId;
    const forfeited = match.forfeit_user_id === userId;

    // Use detailed ELO result if available, fall back to match-level data
    const isWinner = eloResult?.winner_id === userId;
    const eloDelta = eloResult
        ? (isWinner ? eloResult.winner_delta : Math.abs(eloResult.loser_delta))
        : (match.elo_delta ?? 0);
    const oldElo = eloResult
        ? (isWinner ? eloResult.winner_old_elo : eloResult.loser_old_elo)
        : (isChallenger ? match.challenger_elo : match.opponent_elo);
    const newElo = eloResult
        ? (isWinner ? eloResult.winner_new_elo : eloResult.loser_new_elo)
        : (won ? oldElo + eloDelta : lost ? oldElo - eloDelta : oldElo);

    const tierBefore = eloResult
        ? (isWinner ? eloResult.winner_tier_before : eloResult.loser_tier_before)
        : null;
    const tierAfter = eloResult
        ? (isWinner ? eloResult.winner_tier_after : eloResult.loser_tier_after)
        : null;
    const tierChanged = tierBefore && tierAfter && tierBefore !== tierAfter;
    const promoted = tierChanged && tierAfter !== tierBefore;

    const winStreak = eloResult && isWinner ? eloResult.winner_win_streak : 0;
    const streakMultiplier = eloResult ? parseFloat(eloResult.streak_multiplier) : 1;
    const badges = eloResult?.badges_earned ?? [];

    let resultText = "DRAW";
    let resultColor = "var(--ar-gold)";
    if (forfeited) {
        resultText = "YOU FORFEITED";
        resultColor = "var(--ar-red)";
    } else if (won) {
        resultText = "YOU WON";
        resultColor = "var(--ar-g)";
    } else if (lost) {
        resultText = "YOU LOST";
        resultColor = "var(--ar-red)";
    }

    return (
        <div className="lmv-end-backdrop">
            <div className="lmv-end-card">
                <div className="lmv-end-result" style={{ color: resultColor }}>
                    {resultText}
                </div>

                <div className="lmv-end-pnl-row">
                    <div>
                        <div className="lmv-end-label">YOUR P&L</div>
                        <div
                            className="lmv-end-val"
                            style={{ color: parseFloat(yourPnl ?? "0") >= 0 ? "var(--ar-g)" : "var(--ar-red)" }}
                        >
                            {formatPnl(yourPnl)}
                        </div>
                    </div>
                    <div>
                        <div className="lmv-end-label">OPPONENT</div>
                        <div
                            className="lmv-end-val"
                            style={{ color: parseFloat(oppPnl ?? "0") >= 0 ? "var(--ar-g)" : "var(--ar-red)" }}
                        >
                            {formatPnl(oppPnl)}
                        </div>
                    </div>
                </div>

                <div className="lmv-end-elo-section">
                    <div>
                        <div className="lmv-end-label">ELO CHANGE</div>
                        <div
                            className="lmv-end-val"
                            style={{ color: won ? "var(--ar-g)" : lost ? "var(--ar-red)" : "var(--ar-muted)" }}
                        >
                            {won ? `+${eloDelta}` : lost ? `-${eloDelta}` : "0"}
                            {streakMultiplier > 1 && won && (
                                <span style={{ fontSize: "0.7em", marginLeft: 6, color: "var(--ar-gold)" }}>
                                    {streakMultiplier}x STREAK
                                </span>
                            )}
                        </div>
                    </div>
                    <div>
                        <div className="lmv-end-label">NEW ELO</div>
                        <div className="lmv-end-val" style={{ color: "#fff" }}>{newElo}</div>
                    </div>
                </div>

                {/* Tier change */}
                {tierChanged && (
                    <div
                        style={{
                            textAlign: "center",
                            padding: "10px 0",
                            fontSize: 14,
                            fontWeight: 700,
                            letterSpacing: 2,
                            color: promoted ? "var(--ar-gold)" : "var(--ar-red)",
                            animation: "intelAlertPulse 1.5s infinite",
                        }}
                    >
                        {promoted
                            ? `PROMOTED TO ${tierAfter}!`
                            : `DEMOTED TO ${tierAfter}`}
                    </div>
                )}

                {/* Win streak */}
                {won && winStreak >= 2 && (
                    <div
                        style={{
                            textAlign: "center",
                            fontSize: 11,
                            letterSpacing: 3,
                            color: "var(--ar-gold)",
                            padding: "4px 0",
                        }}
                    >
                        {winStreak} WIN STREAK
                    </div>
                )}

                {/* Badges */}
                {badges.length > 0 && (
                    <div
                        style={{
                            textAlign: "center",
                            fontSize: 12,
                            letterSpacing: 2,
                            color: "var(--ar-gold)",
                            padding: "6px 0",
                            fontWeight: 700,
                        }}
                    >
                        {badges.map((b) => (
                            <div key={b}>
                                {b === "STREAK_3" && "BADGE EARNED: 3 WIN STREAK"}
                                {b === "STREAK_5" && "BADGE EARNED: 5 WIN STREAK"}
                                {b === "STREAK_10" && "BADGE EARNED: 10 WIN STREAK"}
                            </div>
                        ))}
                    </div>
                )}

                <div className="lmv-end-actions">
                    <button className="ar-btn ar-btn-orange" onClick={onBackToArena}>
                        BACK TO ARENA
                    </button>
                </div>
            </div>
        </div>
    );
}
