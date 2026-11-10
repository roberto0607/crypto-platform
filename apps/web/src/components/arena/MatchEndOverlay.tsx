import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { Match } from "@/api/endpoints/matches";
import client from "@/api/client";
import { formatMatchPnlPair } from "@/lib/matchPnl";
import { eloChangeText, eloReason } from "@/lib/eloReason";

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
    /** Set when the winner got no ELO (anti-farming rules). */
    winner_unrated_reason?: string | null;
    /** The pair's match number in 24h and who traded enough: for the reason line. */
    pair_match_number?: number | null;
    winner_qualified?: boolean | null;
    loser_qualified?: boolean | null;
}

interface MatchEndOverlayProps {
    match: Match;
    userId: string;
    onBackToArena: () => void;
    onViewBreakdown: () => void;
}

export function MatchEndOverlay({ match, userId, onBackToArena, onViewBreakdown }: MatchEndOverlayProps) {
    const navigate = useNavigate();
    const [eloResult, setEloResult] = useState<EloResult | null>(null);

    useEffect(() => {
        client
            .get<{ ok: true; result: EloResult }>(`/v1/matches/${match.id}/result`)
            .then((res) => setEloResult(res.data.result))
            .catch(() => {}); // Non-fatal — fall back to basic display
    }, [match.id]);

    const isChallenger = match.challenger_id === userId;
    const opponentName = isChallenger ? match.opponent_name : match.challenger_name;
    const yourPnl = isChallenger ? match.challenger_pnl_pct : match.opponent_pnl_pct;
    const oppPnl = isChallenger ? match.opponent_pnl_pct : match.challenger_pnl_pct;
    // Both at one precision, with dollars: different results never look tied.
    const [yourPnlText, oppPnlText] = formatMatchPnlPair(yourPnl, oppPnl, match.starting_capital);
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
        : ((isChallenger ? match.challenger_elo : match.opponent_elo) ?? 1200);
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
    const unrated = won && isWinner && !!eloResult?.winner_unrated_reason;
    // Why the change was unrated or scaled, in plain words (null: full value).
    const reason = eloResult && (won || lost) ? eloReason(eloResult, isWinner ? "winner" : "loser") : null;

    // ── ELO count-up animation ──
    // Counts the NEW ELO from old → new and the delta from 0 → final over 800ms
    // (ease-out), then a single settle pulse. Re-runs once when the detailed
    // eloResult resolves; static for prefers-reduced-motion users.
    const reducedMotion =
        typeof window !== "undefined" &&
        !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const [displayElo, setDisplayElo] = useState(() => (reducedMotion ? newElo : oldElo));
    const [displayDelta, setDisplayDelta] = useState(() => (reducedMotion ? eloDelta : 0));
    const [settleTick, setSettleTick] = useState(0);

    useEffect(() => {
        // Reduced motion, or nothing to animate — land directly on the final values.
        if (reducedMotion || oldElo === newElo) {
            setDisplayElo(newElo);
            setDisplayDelta(eloDelta);
            return;
        }
        const DURATION = 1200;
        const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
        const start = performance.now();
        let raf = requestAnimationFrame(function step(now) {
            const t = Math.min((now - start) / DURATION, 1);
            const e = easeOut(t);
            setDisplayElo(Math.round(oldElo + (newElo - oldElo) * e));
            setDisplayDelta(Math.round(eloDelta * e));
            if (t < 1) {
                raf = requestAnimationFrame(step);
            } else {
                setDisplayElo(newElo);
                setDisplayDelta(eloDelta);
                setSettleTick((n) => n + 1);
            }
        });
        return () => cancelAnimationFrame(raf);
    }, [oldElo, newElo, eloDelta, reducedMotion]);

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
        <div className="mt-end-backdrop">
            <div className="mt-end-card">
                <div className="mt-end-result" style={{ color: resultColor }}>
                    {resultText}
                </div>

                <div className="mt-end-pnl-row">
                    <div>
                        <div className="mt-end-label">YOUR P&L</div>
                        <div
                            className="mt-end-val"
                            style={{ color: parseFloat(yourPnl ?? "0") >= 0 ? "var(--ar-g)" : "var(--ar-red)" }}
                        >
                            {yourPnlText}
                        </div>
                    </div>
                    <div>
                        <div className="mt-end-label">OPPONENT</div>
                        <div
                            className="mt-end-val"
                            style={{ color: parseFloat(oppPnl ?? "0") >= 0 ? "var(--ar-g)" : "var(--ar-red)" }}
                        >
                            {oppPnlText}
                        </div>
                    </div>
                </div>

                <div className="mt-end-elo-section">
                    <div>
                        <div className="mt-end-label">ELO CHANGE</div>
                        <div
                            className="mt-end-val"
                            style={{ color: won ? "var(--ar-g)" : lost ? "var(--ar-red)" : "var(--ar-muted)" }}
                        >
                            <span data-testid="elo-change">{eloChangeText({ won, lost, delta: displayDelta, unrated })}</span>
                            {streakMultiplier > 1 && won && (
                                <span style={{ fontSize: "0.7em", marginLeft: 6, color: "var(--ar-gold)" }}>
                                    {streakMultiplier}x STREAK
                                </span>
                            )}
                        </div>
                        {reason && (
                            <div data-testid="elo-reason" style={{ fontSize: 10, letterSpacing: 1, color: "var(--ar-muted)", marginTop: 4 }}>
                                {reason}
                            </div>
                        )}
                    </div>
                    <div>
                        <div className="mt-end-label">NEW ELO</div>
                        <div
                            key={settleTick}
                            className={`mt-end-val${settleTick > 0 && !reducedMotion ? " elo-settle-pulse" : ""}`}
                            style={{ color: "#fff", display: "inline-block" }}
                        >
                            {displayElo}
                        </div>
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
                {isWinner && badges.length > 0 && (
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

                <div className="mt-end-actions">
                    <button className="ar-btn ar-btn-outline" onClick={onViewBreakdown}>
                        VIEW TRADE BREAKDOWN
                    </button>
                    {opponentName && (
                        <button
                            className="ar-btn ar-btn-outline"
                            onClick={() => {
                                onBackToArena();
                                navigate(`/arena?challenge=${encodeURIComponent(opponentName)}`);
                            }}
                        >
                            REMATCH
                        </button>
                    )}
                    <button className="ar-btn ar-btn-orange" onClick={onBackToArena}>
                        BACK TO ARENA
                    </button>
                </div>
            </div>
        </div>
    );
}
