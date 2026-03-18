import type { Match } from "@/api/endpoints/matches";

function formatPnl(pct: string | null): string {
    if (!pct) return "0.00%";
    const n = parseFloat(pct);
    return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

interface MatchEndOverlayProps {
    match: Match;
    userId: string;
    onBackToArena: () => void;
}

export function MatchEndOverlay({ match, userId, onBackToArena }: MatchEndOverlayProps) {
    const isChallenger = match.challenger_id === userId;
    const yourPnl = isChallenger ? match.challenger_pnl_pct : match.opponent_pnl_pct;
    const oppPnl = isChallenger ? match.opponent_pnl_pct : match.challenger_pnl_pct;
    const won = match.winner_id === userId;
    const lost = match.winner_id != null && match.winner_id !== userId;
    const forfeited = match.forfeit_user_id === userId;

    const eloDelta = match.elo_delta ?? 0;
    const yourElo = isChallenger ? match.challenger_elo : match.opponent_elo;
    const newElo = won ? yourElo + eloDelta : lost ? yourElo - eloDelta : yourElo;

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
                        </div>
                    </div>
                    <div>
                        <div className="lmv-end-label">NEW ELO</div>
                        <div className="lmv-end-val" style={{ color: "#fff" }}>{newElo}</div>
                    </div>
                </div>

                <div className="lmv-end-actions">
                    <button className="ar-btn ar-btn-orange" onClick={onBackToArena}>
                        BACK TO ARENA
                    </button>
                </div>
            </div>
        </div>
    );
}
