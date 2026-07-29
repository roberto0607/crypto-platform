import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";
import { useCompetitionMode } from "@/hooks/useCompetitionMode";
import type { MatchPnlUpdateEvent } from "@/types/api";

/**
 * Persistent reminder strip shown on every route (except /trade and /arena,
 * where the match is already visible via TradingPage's own bar / MatchHeaderBar)
 * while the user has an ACTIVE 1v1 running. Read-only, click-through to /arena.
 *
 * livePnl here is a third copy of the same local-state-plus-sse:match.pnl.update
 * pattern already used by TradingPage and LiveMatchView -- a future refactor
 * candidate to centralize into activeMatchStore, not done here.
 */
export function CompetitionBottomBar() {
    const navigate = useNavigate();
    const location = useLocation();
    const userId = useAuthStore((s) => s.user?.id);
    const { isInCompetition, activeMatch } = useCompetitionMode();

    const [livePnl, setLivePnl] = useState<{ challengerPnlPct: string; opponentPnlPct: string } | null>(null);
    useEffect(() => {
        setLivePnl(null);
    }, [activeMatch?.id]);
    useEffect(() => {
        const handler = (e: Event) => {
            const d = (e as CustomEvent<MatchPnlUpdateEvent>).detail;
            if (!d || !activeMatch || d.matchId !== activeMatch.id) return;
            setLivePnl({ challengerPnlPct: d.challengerPnlPct, opponentPnlPct: d.opponentPnlPct });
        };
        window.addEventListener("sse:match.pnl.update", handler);
        return () => window.removeEventListener("sse:match.pnl.update", handler);
    }, [activeMatch]);

    const suppressed = location.pathname === "/trade" || location.pathname.startsWith("/arena");
    if (suppressed || !isInCompetition || !activeMatch) return null;

    const isChallenger = activeMatch.challenger_id === userId;
    const challengerPnlPct = livePnl?.challengerPnlPct ?? activeMatch.challenger_pnl_pct;
    const opponentPnlPct = livePnl?.opponentPnlPct ?? activeMatch.opponent_pnl_pct;
    const yourPnl = isChallenger ? challengerPnlPct : opponentPnlPct;
    const oppPnl = isChallenger ? opponentPnlPct : challengerPnlPct;
    const oppName = isChallenger ? (activeMatch.opponent_name ?? "OPPONENT") : (activeMatch.challenger_name ?? "OPPONENT");
    const endsAt = activeMatch.ends_at ? new Date(activeMatch.ends_at) : null;
    const msLeft = endsAt ? Math.max(0, endsAt.getTime() - Date.now()) : 0;
    const hrsLeft = Math.floor(msLeft / 3_600_000);
    const minsLeft = Math.floor((msLeft % 3_600_000) / 60_000);
    const timeStr = hrsLeft >= 24 ? `${Math.floor(hrsLeft / 24)}D ${hrsLeft % 24}H` : `${hrsLeft}H ${minsLeft}M`;
    const yPnl = parseFloat(yourPnl ?? "0");
    const oPnl = parseFloat(oppPnl ?? "0");

    return (
        <button
            type="button"
            onClick={() => navigate("/arena")}
            aria-label={`Active 1v1 match vs ${oppName} — click to return`}
            style={{
                position: "fixed", bottom: 36, left: 0, right: 0, zIndex: 99,
                height: 32, display: "flex", alignItems: "center", gap: 24,
                padding: "0 16px", fontFamily: "'Space Mono', monospace",
                fontSize: 10, letterSpacing: 2, color: "#FF6B00",
                background: "rgba(255,107,0,0.06)", border: "none",
                borderTop: "1px solid rgba(255,107,0,0.25)",
                cursor: "pointer", textAlign: "left", width: "100%", margin: 0,

            }}
        >
            <span style={{ color: "#FF6B00", fontWeight: 700 }}>⚔ 1V1</span>
            <span>YOU: <span style={{ color: yPnl >= 0 ? "#00ff41" : "#ff3b3b" }}>{yPnl >= 0 ? "+" : ""}{yPnl.toFixed(2)}%</span></span>
            <span>{oppName.toUpperCase()}: <span style={{ color: oPnl >= 0 ? "#00ff41" : "#ff3b3b" }}>{oPnl >= 0 ? "+" : ""}{oPnl.toFixed(2)}%</span></span>
            <span style={{ marginLeft: "auto", color: "rgba(255,107,0,0.6)" }}>TIME: {timeStr}</span>
        </button>
    );
}
