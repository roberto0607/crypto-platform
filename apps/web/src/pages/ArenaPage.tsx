import { useState, useEffect, useCallback } from "react";
import { useAuthStore } from "@/stores/authStore";
import { useCompetitionStore } from "@/stores/competitionStore";
import { useAppStore } from "@/stores/appStore";
import {
    challengeUser,
    acceptMatch,
    forfeitMatch,
    cancelActiveMatch,
    getActiveMatch,
    getMatchHistory,
    type Match,
} from "@/api/endpoints/matches";
import { listCompetitions, getLeaderboard, type LeaderboardEntry } from "@/api/endpoints/competitions";
import { LiveMatchView } from "@/components/arena/LiveMatchView";
import { SeasonLeaderboard } from "@/components/arena/SeasonLeaderboard";

/* ─────────────────────────────────────────
   ARENA PAGE CSS — Trade Wars
───────────────────────────────────────── */
const ARENA_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap');

  .ar-wrap {
    --ar-g: #00ff41; --ar-red: #ff3b3b; --ar-orange: #FF6B00;
    --ar-gold: #FFD700; --ar-bg: #040404; --ar-bg2: #080808;
    --ar-border: rgba(0,255,65,0.16); --ar-borderW: rgba(255,255,255,0.06);
    --ar-muted: rgba(255,255,255,0.3); --ar-faint: rgba(255,255,255,0.05);
    --ar-bebas: 'Bebas Neue', sans-serif; --ar-mono: 'Space Mono', monospace;
    padding:16px 24px 24px;font-family:var(--ar-mono);color:rgba(255,255,255,0.88);
    position:relative;z-index:10;min-height:100%;
  }

  /* Header */
  .ar-header { display:flex;align-items:center;justify-content:space-between;margin-bottom:20px; }
  .ar-title { font-family:var(--ar-bebas);font-size:36px;letter-spacing:6px;color:var(--ar-orange); }
  .ar-subtitle { font-size:9px;color:var(--ar-muted);letter-spacing:3px;margin-top:2px; }

  /* Season card */
  .ar-season-card {
    border:1px solid var(--ar-orange);background:rgba(255,107,0,0.04);
    padding:16px 20px;margin-bottom:20px;display:grid;grid-template-columns:repeat(5,1fr);gap:16px;
  }
  .ar-sc-item { text-align:center; }
  .ar-sc-val { font-family:var(--ar-bebas);font-size:28px;letter-spacing:2px;color:#fff; }
  .ar-sc-val.orange { color:var(--ar-orange); }
  .ar-sc-val.gold { color:var(--ar-gold); }
  .ar-sc-val.green { color:var(--ar-g); }
  .ar-sc-lbl { font-size:8px;color:var(--ar-muted);letter-spacing:3px;margin-top:2px; }

  /* Tabs */
  .ar-tabs { display:flex;border-bottom:1px solid var(--ar-borderW);margin-bottom:16px; }
  .ar-tab {
    padding:10px 24px;font-size:10px;letter-spacing:3px;color:var(--ar-muted);
    cursor:pointer;border-bottom:2px solid transparent;transition:all 0.15s;
  }
  .ar-tab:hover { color:#fff; }
  .ar-tab.active { color:var(--ar-orange);border-bottom-color:var(--ar-orange); }

  /* Table */
  .ar-tbl { width:100%;border-collapse:collapse; }
  .ar-tbl th {
    font-size:8px;color:rgba(255,255,255,0.4);letter-spacing:3px;text-transform:uppercase;
    padding:8px 12px;border-bottom:1px solid var(--ar-borderW);text-align:left;
  }
  .ar-tbl td { padding:10px 12px;font-size:11px;border-bottom:1px solid var(--ar-faint); }
  .ar-tbl tr:hover td { background:rgba(255,107,0,0.04); }

  /* Match card */
  .ar-match-card {
    border:1px solid var(--ar-orange);background:rgba(255,107,0,0.04);
    padding:20px;margin-bottom:16px;
  }
  .ar-mc-header { display:flex;justify-content:space-between;align-items:center;margin-bottom:16px; }
  .ar-mc-vs { font-family:var(--ar-bebas);font-size:24px;letter-spacing:4px;color:var(--ar-orange); }
  .ar-mc-timer { font-family:var(--ar-bebas);font-size:18px;color:var(--ar-red);letter-spacing:2px; }
  .ar-mc-scores {
    display:grid;grid-template-columns:1fr auto 1fr;gap:16px;align-items:center;text-align:center;
  }
  .ar-mc-player { font-size:10px;color:var(--ar-muted);letter-spacing:2px;margin-bottom:4px; }
  .ar-mc-pnl { font-family:var(--ar-bebas);font-size:36px;letter-spacing:2px; }
  .ar-mc-divider { width:1px;height:50px;background:var(--ar-borderW); }

  /* Buttons */
  .ar-btn {
    padding:10px 24px;font-family:var(--ar-mono);font-size:11px;font-weight:700;
    letter-spacing:3px;text-transform:uppercase;cursor:pointer;border:none;
    transition:all 0.2s;clip-path:polygon(6px 0%,100% 0%,calc(100% - 6px) 100%,0% 100%);
  }
  .ar-btn-orange { background:var(--ar-orange);color:#000; }
  .ar-btn-orange:hover { background:#ff8533;box-shadow:0 0 20px rgba(255,107,0,0.3); }
  .ar-btn-outline {
    background:transparent;color:var(--ar-orange);border:1px solid var(--ar-orange);
    clip-path:none;
  }
  .ar-btn-outline:hover { background:rgba(255,107,0,0.08); }
  .ar-btn-red { background:var(--ar-red);color:#fff; }
  .ar-btn-red:hover { background:#ff5555; }
  .ar-btn:disabled { opacity:0.4;cursor:not-allowed; }

  /* Empty state */
  .ar-empty {
    text-align:center;padding:40px;color:var(--ar-muted);font-size:11px;letter-spacing:2px;
  }

  /* Win/Loss badges */
  .ar-win { color:var(--ar-g);font-size:9px;letter-spacing:2px;border:1px solid rgba(0,255,65,0.3);padding:2px 8px; }
  .ar-loss { color:var(--ar-red);font-size:9px;letter-spacing:2px;border:1px solid rgba(255,59,59,0.3);padding:2px 8px; }
  .ar-draw { color:var(--ar-gold);font-size:9px;letter-spacing:2px;border:1px solid rgba(255,215,0,0.3);padding:2px 8px; }

  /* Challenge form */
  .ar-challenge-form { display:flex;gap:8px;align-items:center;margin-bottom:16px; }
  .ar-input {
    flex:1;background:rgba(255,255,255,0.04);border:1px solid var(--ar-borderW);
    padding:8px 12px;font-family:var(--ar-mono);font-size:11px;color:#fff;
    letter-spacing:1px;outline:none;
  }
  .ar-input:focus { border-color:var(--ar-orange); }
  .ar-input::placeholder { color:rgba(255,255,255,0.15); }

  .ar-select {
    background:rgba(255,255,255,0.04);border:1px solid var(--ar-borderW);
    padding:8px 12px;font-family:var(--ar-mono);font-size:11px;color:#fff;
    letter-spacing:1px;outline:none;cursor:pointer;
  }
  .ar-select:focus { border-color:var(--ar-orange); }

  .ar-elo-badge {
    font-family:var(--ar-bebas);font-size:14px;letter-spacing:2px;
    padding:2px 8px;display:inline-block;
  }
`;

const DURATION_OPTIONS = [
    { value: 24, label: "24H" },
    { value: 168, label: "1 WEEK" },
    { value: 336, label: "2 WEEKS" },
    { value: 504, label: "3 WEEKS" },
    { value: 672, label: "4 WEEKS" },
];

function formatTimeRemaining(endsAt: string): string {
    const diff = new Date(endsAt).getTime() - Date.now();
    if (diff <= 0) return "ENDED";
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    const mins = Math.floor((diff % 3_600_000) / 60_000);
    if (days > 0) return `${days}D ${hours}H`;
    if (hours > 0) return `${hours}H ${mins}M`;
    return `${mins}M`;
}

function formatPnl(pct: string | null): string {
    if (!pct) return "0.00%";
    const n = parseFloat(pct);
    return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

export default function ArenaPage() {
    const userId = useAuthStore((s) => s.user?.id);
    const userTier = useCompetitionStore((s) => s.userTier);
    const pairs = useAppStore((s) => s.pairs);

    const [tab, setTab] = useState<"SEASON" | "1V1">("1V1");
    const [activeMatch, setActiveMatch] = useState<Match | null>(null);
    const [matchHistory, setMatchHistory] = useState<Match[]>([]);
    const [historyTotal, setHistoryTotal] = useState(0);
    const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
    const [seasonInfo, setSeasonInfo] = useState<{ id: string; name: string; end_at: string; season_number?: number } | null>(null);

    // Challenge form
    const [challengeInput, setChallengeInput] = useState("");
    const [duration, setDuration] = useState(24);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [matchBlocked, setMatchBlocked] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [seasonLoading, setSeasonLoading] = useState(true);
    const [seasonError, setSeasonError] = useState(false);

    const loadActiveMatch = useCallback(async () => {
        try {
            const { data } = await getActiveMatch();
            setActiveMatch(data.match);
        } catch { /* ignore */ }
    }, []);

    const loadMatchHistory = useCallback(async () => {
        try {
            const { data } = await getMatchHistory({ limit: 20 });
            setMatchHistory(data.matches);
            setHistoryTotal(data.total);
        } catch { /* ignore */ }
    }, []);

    const loadSeason = useCallback(async () => {
        setSeasonLoading(true);
        setSeasonError(false);
        try {
            const { data } = await listCompetitions({ competition_type: "SEASON", status: "ACTIVE", limit: 1 });
            const comps = data.competitions ?? (data as any).data ?? [];
            if (comps.length > 0) {
                const s = comps[0]!;
                setSeasonInfo({ id: s.id, name: s.name, end_at: s.end_at, season_number: (s as any).season_number });
                const lb = await getLeaderboard(s.id, { limit: 50 });
                setLeaderboard(lb.data.leaderboard ?? (lb.data as any).data ?? []);
            }
        } catch {
            setSeasonError(true);
        } finally {
            setSeasonLoading(false);
        }
    }, []);

    useEffect(() => {
        loadActiveMatch();
        loadMatchHistory();
        loadSeason();
    }, [loadActiveMatch, loadMatchHistory, loadSeason]);

    // Auto-transition to LiveMatchView when a match is accepted (SSE push)
    useEffect(() => {
        const handler = () => { loadActiveMatch(); };
        window.addEventListener("sse:match.started", handler);
        return () => { window.removeEventListener("sse:match.started", handler); };
    }, [loadActiveMatch]);

    // Show incoming challenge when opponent sends one (SSE push)
    useEffect(() => {
        const handler = () => { loadActiveMatch(); };
        window.addEventListener("sse:challenge.received", handler);
        return () => { window.removeEventListener("sse:challenge.received", handler); };
    }, [loadActiveMatch]);

    // Re-sync match state after SSE reconnects (may have missed events)
    useEffect(() => {
        const handler = () => { loadActiveMatch(); loadMatchHistory(); };
        window.addEventListener("sse:reconnected", handler);
        return () => { window.removeEventListener("sse:reconnected", handler); };
    }, [loadActiveMatch, loadMatchHistory]);

    async function handleChallenge() {
        if (!challengeInput.trim()) return;
        setSubmitting(true);
        setError(null);
        setMatchBlocked(false);
        try {
            const activePairIds = pairs.filter((p) => p.is_active).map((p) => p.id);
            await challengeUser({
                opponentId: challengeInput.trim(),
                durationHours: duration,
                allowedPairIds: activePairIds.slice(0, 3),
            });
            setChallengeInput("");
            await loadActiveMatch();
        } catch (err: any) {
            const code = err?.response?.data?.code;
            if (code === "match_already_active") {
                setError("You have a stuck match blocking new challenges.");
                setMatchBlocked(true);
            } else {
                setError(err?.response?.data?.message ?? code ?? "Challenge failed");
            }
        } finally {
            setSubmitting(false);
        }
    }

    async function handleCancelActiveMatch() {
        setCancelling(true);
        try {
            await cancelActiveMatch();
            setError(null);
            setMatchBlocked(false);
            await loadActiveMatch();
            await loadMatchHistory();
        } catch (err: any) {
            const code = err?.response?.data?.code;
            if (code === "match_has_trades") {
                setError("Match has trades — use FORFEIT instead.");
                await loadActiveMatch();
            } else {
                setError(err?.response?.data?.message ?? "Cancel failed");
            }
        } finally {
            setCancelling(false);
        }
    }

    async function handleAccept() {
        if (!activeMatch) return;
        try {
            await acceptMatch(activeMatch.id);
            await loadActiveMatch();
        } catch { /* ignore */ }
    }

    async function handleForfeit() {
        if (!activeMatch) return;
        try {
            await forfeitMatch(activeMatch.id);
            await loadActiveMatch();
            await loadMatchHistory();
        } catch { /* ignore */ }
    }

    const daysLeft = seasonInfo ? formatTimeRemaining(seasonInfo.end_at) : "--";

    // ── LIVE MATCH VIEW — replaces lobby when match is active ──
    if (activeMatch && activeMatch.status === "ACTIVE") {
        return (
            <LiveMatchView
                match={activeMatch}
                onMatchEnd={() => {
                    setActiveMatch(null);
                    loadMatchHistory();
                }}
            />
        );
    }

    return (
        <>
            <style>{ARENA_CSS}</style>
            <div className="ar-wrap">
                {/* HEADER */}
                <div className="ar-header">
                    <div>
                        <div className="ar-title">TRADE WARS</div>
                        <div className="ar-subtitle">COMPETE. CONQUER. CLIMB.</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                        <div className="ar-elo-badge" style={{ color: "var(--ar-orange)", border: "1px solid var(--ar-orange)", background: "rgba(255,107,0,0.06)" }}>
                            {userTier}
                        </div>
                    </div>
                </div>

                {/* SEASON STATUS */}
                {seasonLoading && (
                    <div className="ar-season-card" style={{ justifyContent: "center", opacity: 0.4 }}>
                        <div style={{ fontFamily: "var(--ar-mono)", fontSize: 10, letterSpacing: 3, color: "var(--ar-muted)" }}>
                            LOADING SEASON DATA...
                        </div>
                    </div>
                )}
                {!seasonLoading && seasonError && (
                    <div className="ar-season-card" style={{ justifyContent: "center" }}>
                        <div style={{ fontFamily: "var(--ar-mono)", fontSize: 10, letterSpacing: 2, color: "var(--ar-red)" }}>
                            SEASON DATA UNAVAILABLE — SERVER OFFLINE
                        </div>
                    </div>
                )}
                {!seasonLoading && !seasonError && seasonInfo && (
                    <div className="ar-season-card">
                        <div className="ar-sc-item">
                            <div className="ar-sc-val orange">S{seasonInfo.season_number ?? "?"}</div>
                            <div className="ar-sc-lbl">SEASON</div>
                        </div>
                        <div className="ar-sc-item">
                            <div className="ar-sc-val">{daysLeft}</div>
                            <div className="ar-sc-lbl">REMAINING</div>
                        </div>
                        <div className="ar-sc-item">
                            <div className="ar-sc-val gold">#{leaderboard.findIndex((e) => e.user_id === userId) + 1 || "--"}</div>
                            <div className="ar-sc-lbl">YOUR RANK</div>
                        </div>
                        <div className="ar-sc-item">
                            <div className="ar-sc-val green">
                                {(() => {
                                    const entry = leaderboard.find((e) => e.user_id === userId);
                                    return entry ? parseFloat((entry as any).nuanced_score ?? entry.return_pct ?? "0").toFixed(0) : "--";
                                })()}
                            </div>
                            <div className="ar-sc-lbl">SCORE</div>
                        </div>
                        <div className="ar-sc-item">
                            <div className="ar-sc-val" style={{ color: "var(--ar-g)" }}>
                                {(() => {
                                    const entry = leaderboard.find((e) => e.user_id === userId);
                                    return entry ? formatPnl(entry.return_pct) : "--";
                                })()}
                            </div>
                            <div className="ar-sc-lbl">RETURN</div>
                        </div>
                    </div>
                )}

                {/* TABS */}
                <div className="ar-tabs">
                    {(["SEASON", "1V1"] as const).map((t) => (
                        <div key={t} className={`ar-tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
                            {t}
                        </div>
                    ))}
                </div>

                {/* ═══ SEASON TAB ═══ */}
                {tab === "SEASON" && (
                    <SeasonLeaderboard
                        seasonInfo={seasonInfo}
                        seasonLoading={seasonLoading}
                        seasonError={seasonError}
                    />
                )}

                {/* ═══ 1V1 TAB ═══ */}
                {tab === "1V1" && (
                    <>
                        {/* Active Match */}
                        {activeMatch && (activeMatch.status === "ACTIVE" || activeMatch.status === "PENDING") && (
                            <div className="ar-match-card">
                                <div className="ar-mc-header">
                                    <div className="ar-mc-vs">
                                        {activeMatch.status === "PENDING" ? "CHALLENGE SENT" : "MATCH LIVE"}
                                    </div>
                                    {activeMatch.ends_at && (
                                        <div className="ar-mc-timer">
                                            {formatTimeRemaining(activeMatch.ends_at)}
                                        </div>
                                    )}
                                </div>

                                {activeMatch.status === "ACTIVE" && (
                                    <div className="ar-mc-scores">
                                        <div>
                                            <div className="ar-mc-player">
                                                {activeMatch.challenger_id === userId ? "YOU" : (activeMatch.challenger_name ?? "CHALLENGER")}
                                            </div>
                                            <div className="ar-mc-pnl" style={{ color: parseFloat(activeMatch.challenger_pnl_pct ?? "0") >= 0 ? "var(--ar-g)" : "var(--ar-red)" }}>
                                                {formatPnl(activeMatch.challenger_pnl_pct)}
                                            </div>
                                        </div>
                                        <div className="ar-mc-divider" />
                                        <div>
                                            <div className="ar-mc-player">
                                                {activeMatch.opponent_id === userId ? "YOU" : (activeMatch.opponent_name ?? "OPPONENT")}
                                            </div>
                                            <div className="ar-mc-pnl" style={{ color: parseFloat(activeMatch.opponent_pnl_pct ?? "0") >= 0 ? "var(--ar-g)" : "var(--ar-red)" }}>
                                                {formatPnl(activeMatch.opponent_pnl_pct)}
                                            </div>
                                        </div>
                                    </div>
                                )}

                                <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                                    {activeMatch.status === "PENDING" && activeMatch.opponent_id === userId && (
                                        <button className="ar-btn ar-btn-orange" onClick={handleAccept}>ACCEPT</button>
                                    )}
                                    {activeMatch.status === "ACTIVE" && (
                                        <button className="ar-btn ar-btn-red" onClick={handleForfeit}>FORFEIT</button>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Challenge Form */}
                        {!activeMatch && (
                            <>
                                <div style={{ marginBottom: 16 }}>
                                    <div style={{ fontSize: 9, color: "var(--ar-muted)", letterSpacing: 3, marginBottom: 8 }}>
                                        CHALLENGE A TRADER
                                    </div>
                                    <div className="ar-challenge-form">
                                        <input
                                            className="ar-input"
                                            placeholder="OPPONENT USER ID"
                                            value={challengeInput}
                                            onChange={(e) => setChallengeInput(e.target.value)}
                                        />
                                        <select
                                            className="ar-select"
                                            value={duration}
                                            onChange={(e) => setDuration(parseInt(e.target.value, 10))}
                                        >
                                            {DURATION_OPTIONS.map((d) => (
                                                <option key={d.value} value={d.value}>{d.label}</option>
                                            ))}
                                        </select>
                                        <button
                                            className="ar-btn ar-btn-orange"
                                            disabled={submitting || !challengeInput.trim()}
                                            onClick={handleChallenge}
                                        >
                                            {submitting ? "..." : "CHALLENGE"}
                                        </button>
                                    </div>
                                    {error && (
                                        <div style={{ fontSize: 10, color: "var(--ar-red)", marginTop: 4 }}>{error}</div>
                                    )}
                                    {matchBlocked && (
                                        <button
                                            className="ar-btn ar-btn-red"
                                            style={{ marginTop: 8 }}
                                            disabled={cancelling}
                                            onClick={handleCancelActiveMatch}
                                        >
                                            {cancelling ? "CANCELLING..." : "CANCEL STUCK MATCH"}
                                        </button>
                                    )}
                                </div>
                            </>
                        )}

                        {/* Match History */}
                        <div style={{ marginTop: 20 }}>
                            <div style={{ fontSize: 9, color: "var(--ar-muted)", letterSpacing: 3, marginBottom: 8 }}>
                                MATCH HISTORY ({historyTotal})
                            </div>
                            {matchHistory.length === 0 ? (
                                <div className="ar-empty">NO MATCHES YET</div>
                            ) : (
                                <table className="ar-tbl">
                                    <thead>
                                        <tr>
                                            <th>OPPONENT</th>
                                            <th>RESULT</th>
                                            <th>YOUR P&L</th>
                                            <th>THEIR P&L</th>
                                            <th>ELO</th>
                                            <th>DATE</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {matchHistory.map((m) => {
                                            const isChallenger = m.challenger_id === userId;
                                            const opponentName = isChallenger ? (m.opponent_name ?? "?") : (m.challenger_name ?? "?");
                                            const yourPnl = isChallenger ? m.challenger_pnl_pct : m.opponent_pnl_pct;
                                            const theirPnl = isChallenger ? m.opponent_pnl_pct : m.challenger_pnl_pct;
                                            const won = m.winner_id === userId;
                                            const lost = m.winner_id && m.winner_id !== userId;
                                            const eloDelta = m.elo_delta ?? 0;
                                            const eloDisplay = won ? `+${eloDelta}` : lost ? `-${eloDelta}` : "0";

                                            return (
                                                <tr key={m.id}>
                                                    <td style={{ color: "rgba(255,255,255,0.7)" }}>{opponentName}</td>
                                                    <td>
                                                        {m.status === "FORFEITED" && m.forfeit_user_id === userId
                                                            ? <span className="ar-loss">FORFEIT</span>
                                                            : won
                                                                ? <span className="ar-win">WIN</span>
                                                                : lost
                                                                    ? <span className="ar-loss">LOSS</span>
                                                                    : <span className="ar-draw">DRAW</span>}
                                                    </td>
                                                    <td style={{ color: parseFloat(yourPnl ?? "0") >= 0 ? "var(--ar-g)" : "var(--ar-red)" }}>
                                                        {formatPnl(yourPnl)}
                                                    </td>
                                                    <td style={{ color: "rgba(255,255,255,0.4)" }}>{formatPnl(theirPnl)}</td>
                                                    <td style={{ color: won ? "var(--ar-g)" : lost ? "var(--ar-red)" : "var(--ar-muted)" }}>
                                                        {eloDisplay}
                                                    </td>
                                                    <td style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>
                                                        {m.completed_at ? new Date(m.completed_at).toLocaleDateString([], { month: "short", day: "numeric" }) : "--"}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </>
                )}
            </div>
        </>
    );
}
