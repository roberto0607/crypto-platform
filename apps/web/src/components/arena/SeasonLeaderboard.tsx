import { useState, useEffect, useCallback, useRef } from "react";
import { useAuthStore } from "@/stores/authStore";
import {
    getLeaderboard,
    type Competition,
    type LeaderboardEntry,
} from "@/api/endpoints/competitions";
import { LeaderboardRow } from "./LeaderboardRow";

/* ─────────────────────────────────────────
   SEASON LEADERBOARD CSS
───────────────────────────────────────── */
const SLB_CSS = `
  .slb-wrap {
    --slb-bebas: 'Bebas Neue', sans-serif;
    --slb-mono: 'Space Mono', monospace;
    font-family: var(--slb-mono);
  }

  /* ── STAT CARDS ── */
  .slb-stat-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-bottom: 12px;
  }
  .slb-stat-card {
    background: #261200;
    border: 1px solid rgba(255,107,0,0.2);
    border-radius: 6px;
    padding: 10px 12px;
    text-align: center;
  }
  .slb-stat-lbl {
    font-size: 8px;
    letter-spacing: 3px;
    color: rgba(255,107,0,0.5);
    margin-bottom: 4px;
  }
  .slb-stat-val {
    font-family: var(--slb-bebas);
    font-size: 22px;
    letter-spacing: 2px;
    color: #FF6B00;
  }
  .slb-stat-val.green { color: #4ade80; }
  .slb-stat-val.red { color: #f87171; }
  .slb-stat-val.white { color: #fff; }

  /* ── PHASE BANNER ── */
  .slb-phase {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    background: rgba(255,107,0,0.04);
    border: 1px solid rgba(255,107,0,0.15);
    border-radius: 6px;
    margin-bottom: 12px;
  }
  .slb-phase-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 3px;
    color: #FF6B00;
  }
  .slb-phase-countdown {
    font-size: 10px;
    letter-spacing: 2px;
    color: rgba(255,255,255,0.4);
  }
  .slb-phase-countdown.urgent {
    color: #f87171;
    animation: slb-pulse 1s ease-in-out infinite;
  }
  @keyframes slb-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  /* ── YOUR POSITION BANNER ── */
  .slb-your-pos {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 8px 14px;
    background: rgba(255,107,0,0.08);
    border: 1px solid rgba(255,107,0,0.25);
    border-radius: 6px;
    margin-bottom: 16px;
  }
  .slb-your-rank {
    font-family: var(--slb-bebas);
    font-size: 32px;
    letter-spacing: 2px;
    color: #FF6B00;
    flex-shrink: 0;
  }
  .slb-your-name {
    font-size: 12px;
    font-weight: 700;
    color: #FF6B00;
    letter-spacing: 2px;
  }
  .slb-your-mid { flex: 1; min-width: 0; }
  .slb-progress-bar {
    height: 4px;
    background: rgba(255,107,0,0.1);
    border-radius: 2px;
    margin-top: 6px;
    overflow: hidden;
  }
  .slb-progress-fill {
    height: 100%;
    background: #FF6B00;
    border-radius: 2px;
    transition: width 0.3s ease;
  }
  .slb-your-time {
    font-size: 10px;
    letter-spacing: 2px;
    color: rgba(255,255,255,0.4);
    flex-shrink: 0;
  }

  /* ── TABLE ── */
  .slb-table {
    width: 100%;
    border-collapse: collapse;
    background: #1f0f00;
    border: 1px solid rgba(255,107,0,0.2);
    border-radius: 6px;
    overflow: hidden;
  }
  .slb-table thead th {
    font-size: 8px;
    color: rgba(255,107,0,0.5);
    letter-spacing: 3px;
    text-transform: uppercase;
    padding: 10px 12px;
    border-bottom: 1px solid rgba(255,107,0,0.2);
    text-align: left;
    font-weight: 400;
  }
  .slb-row { transition: background 0.15s; }
  .slb-row:hover { background: rgba(255,107,0,0.06) !important; }
  .slb-cell {
    padding: 10px 12px;
    border-bottom: 1px solid rgba(255,255,255,0.03);
    font-family: var(--slb-mono);
  }
  .slb-rank-cell { width: 44px; }
  .slb-trader-cell { width: auto; }

  /* Column grid: 44px 1fr 80px 80px 70px 70px */
  .slb-table th:nth-child(1), .slb-table td:nth-child(1) { width: 44px; }
  .slb-table th:nth-child(3), .slb-table td:nth-child(3) { width: 80px; }
  .slb-table th:nth-child(4), .slb-table td:nth-child(4) { width: 80px; }
  .slb-table th:nth-child(5), .slb-table td:nth-child(5) { width: 70px; }
  .slb-table th:nth-child(6), .slb-table td:nth-child(6) { width: 70px; }

  .slb-table-footer {
    padding: 12px;
    text-align: center;
    font-size: 9px;
    letter-spacing: 3px;
    color: rgba(255,107,0,0.3);
    border-top: 1px solid rgba(255,107,0,0.1);
  }

  /* ── LIVE DOT ── */
  .slb-live-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #FF6B00;
    margin-right: 8px;
    animation: slb-pulse 2s ease-in-out infinite;
  }

  /* ── LOADING SKELETON ── */
  .slb-skel-row {
    display: grid;
    grid-template-columns: 44px 1fr 80px 80px 70px 70px;
    gap: 0;
    padding: 10px 12px;
    border-bottom: 1px solid rgba(255,255,255,0.03);
  }
  .slb-skel-block {
    height: 14px;
    border-radius: 3px;
    background: rgba(255,107,0,0.05);
    animation: slb-skel-anim 0.8s ease-in-out infinite alternate;
  }
  @keyframes slb-skel-anim {
    from { opacity: 0.3; }
    to { opacity: 0.8; }
  }

  /* ── ERROR STATE ── */
  .slb-error {
    text-align: center;
    padding: 40px;
    color: rgba(255,107,0,0.5);
    font-size: 11px;
    letter-spacing: 2px;
  }
  .slb-error-btn {
    margin-top: 12px;
    padding: 8px 20px;
    font-family: var(--slb-mono);
    font-size: 10px;
    letter-spacing: 3px;
    color: #FF6B00;
    border: 1px solid rgba(255,107,0,0.3);
    background: transparent;
    cursor: pointer;
    transition: all 0.15s;
  }
  .slb-error-btn:hover {
    background: rgba(255,107,0,0.08);
  }

  /* ── EMPTY STATE ── */
  .slb-empty {
    text-align: center;
    padding: 40px;
    color: rgba(255,107,0,0.3);
    font-size: 11px;
    letter-spacing: 2px;
  }

  /* ── TITLE ROW ── */
  .slb-title-row {
    display: flex;
    align-items: center;
    margin-bottom: 12px;
  }
  .slb-title {
    font-size: 9px;
    letter-spacing: 3px;
    color: rgba(255,107,0,0.5);
  }
`;

/* ── PHASE LABELS ── */
const PHASE_LABELS: Record<string, string> = {
    WEEK_1: "\u25C6 WEEK 1 \u2014 OPEN TRADING",
    WEEK_2: "\u25C6 WEEK 2 \u2014 OPEN TRADING",
    WEEK_3: "\u25C6 WEEK 3 \u2014 MID SEASON",
    WEEK_4: "\u25C6 WEEK 4 \u2014 FINAL PUSH",
    OFF_SEASON: "\u25C6 OFF SEASON \u2014 NEXT SEASON SOON",
};

function formatCountdown(endDate: string): string {
    const diff = new Date(endDate).getTime() - Date.now();
    if (diff <= 0) return "ENDED";
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    const mins = Math.floor((diff % 3_600_000) / 60_000);
    const secs = Math.floor((diff % 60_000) / 1_000);
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
    return `${mins}m ${secs}s`;
}

function derivePhase(season: Competition): string {
    const start = new Date(season.start_at).getTime();
    const end = new Date(season.end_at).getTime();
    const now = Date.now();
    if (now >= end) return "OFF_SEASON";
    const total = end - start;
    const elapsed = now - start;
    const pct = elapsed / total;
    if (pct < 0.25) return "WEEK_1";
    if (pct < 0.5) return "WEEK_2";
    if (pct < 0.75) return "WEEK_3";
    return "WEEK_4";
}

/* ─────────────────────────────────────────
   SKELETON ROWS
───────────────────────────────────────── */
function SkeletonRows() {
    return (
        <>
            {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="slb-skel-row">
                    <div><div className="slb-skel-block" style={{ width: 28 }} /></div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div className="slb-skel-block" style={{ width: 26, height: 26, borderRadius: "50%" }} />
                        <div className="slb-skel-block" style={{ width: 80 + Math.random() * 40 }} />
                    </div>
                    <div><div className="slb-skel-block" style={{ width: 40 }} /></div>
                    <div><div className="slb-skel-block" style={{ width: 50 }} /></div>
                    <div><div className="slb-skel-block" style={{ width: 36 }} /></div>
                    <div><div className="slb-skel-block" style={{ width: 28 }} /></div>
                </div>
            ))}
        </>
    );
}

/* ─────────────────────────────────────────
   MAIN COMPONENT
───────────────────────────────────────── */
interface SeasonLeaderboardProps {
    seasonInfo: { id: string; name: string; end_at: string; season_number?: number } | null;
    seasonLoading: boolean;
    seasonError: boolean;
}

export function SeasonLeaderboard({ seasonInfo, seasonLoading, seasonError }: SeasonLeaderboardProps) {
    const userId = useAuthStore((s) => s.user?.id);

    const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [timeLeft, setTimeLeft] = useState("");
    const lastGoodData = useRef<LeaderboardEntry[]>([]);

    // Fetch leaderboard
    const fetchLeaderboard = useCallback(async (isRefresh = false) => {
        if (!seasonInfo) return;
        if (!isRefresh) setLoading(true);
        setError(false);
        try {
            const { data } = await getLeaderboard(seasonInfo.id, { limit: 50 });
            const lb = data.leaderboard ?? (data as any).data ?? [];
            setEntries(lb);
            lastGoodData.current = lb;
            if (!isRefresh) setLoading(false);
        } catch {
            if (!isRefresh) {
                setError(true);
                setLoading(false);
            }
            // On refresh failure, keep showing last good data
        }
    }, [seasonInfo]);

    // Initial fetch
    useEffect(() => {
        fetchLeaderboard(false);
    }, [fetchLeaderboard]);

    // Auto-refresh every 60s
    useEffect(() => {
        if (!seasonInfo) return;
        const id = setInterval(() => fetchLeaderboard(true), 60_000);
        return () => clearInterval(id);
    }, [fetchLeaderboard, seasonInfo]);

    // Countdown timer — ticks every second
    useEffect(() => {
        if (!seasonInfo) return;
        const tick = () => setTimeLeft(formatCountdown(seasonInfo.end_at));
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [seasonInfo]);

    // Inject CSS
    useEffect(() => {
        const id = "slb-css";
        if (!document.getElementById(id)) {
            const s = document.createElement("style");
            s.id = id;
            s.textContent = SLB_CSS;
            document.head.appendChild(s);
        }
    }, []);

    // ── Season not loaded yet ──
    if (seasonLoading) {
        return (
            <div className="slb-wrap">
                <div className="slb-empty">LOADING SEASON DATA...</div>
            </div>
        );
    }
    if (seasonError) {
        return (
            <div className="slb-wrap">
                <div className="slb-error">
                    SEASON DATA UNAVAILABLE
                    <br />
                    <button className="slb-error-btn" onClick={() => window.location.reload()}>RETRY</button>
                </div>
            </div>
        );
    }
    if (!seasonInfo) {
        return (
            <div className="slb-wrap">
                <div className="slb-empty">NO ACTIVE SEASON</div>
            </div>
        );
    }

    // ── Derived data ──
    const phase = derivePhase(seasonInfo as unknown as Competition);
    const phaseLabel = PHASE_LABELS[phase] ?? PHASE_LABELS.WEEK_1;
    const timeMs = new Date(seasonInfo.end_at).getTime() - Date.now();
    const isUrgent = timeMs > 0 && timeMs < 3_600_000; // < 1 hour

    // Find user's entry
    const displayData = entries.length > 0 ? entries : lastGoodData.current;
    const myEntry = displayData.find((e) => e.user_id === userId);
    const myRank = myEntry?.rank ?? displayData.length + 1;
    const myScore = myEntry ? parseFloat((myEntry as any).nuanced_score ?? myEntry.return_pct ?? "0") : 0;
    const myPnl = myEntry ? parseFloat(myEntry.return_pct ?? "0") : 0;

    // Progress toward next rank: score of user one rank above you
    const nextRankEntry = displayData.find((e) => e.rank === myRank - 1);
    const nextRankScore = nextRankEntry
        ? parseFloat((nextRankEntry as any).nuanced_score ?? nextRankEntry.return_pct ?? "0")
        : myScore;
    const progressPct = myRank === 1
        ? 100
        : nextRankScore > 0
            ? Math.min(100, Math.max(0, (myScore / nextRankScore) * 100))
            : 0;

    const totalParticipants = displayData.length;
    const anonymousCount = Math.max(0, totalParticipants - 10);

    return (
        <div className="slb-wrap">
            {/* ── STAT CARDS ── */}
            <div className="slb-stat-grid">
                <div className="slb-stat-card">
                    <div className="slb-stat-lbl">YOUR RANK</div>
                    <div className="slb-stat-val">
                        {myEntry ? `#${myRank}` : "--"}
                    </div>
                </div>
                <div className="slb-stat-card">
                    <div className="slb-stat-lbl">YOUR SCORE</div>
                    <div className="slb-stat-val">
                        {myEntry ? myScore.toFixed(0) : "--"}
                    </div>
                </div>
                <div className="slb-stat-card">
                    <div className="slb-stat-lbl">YOUR P&L</div>
                    <div className={`slb-stat-val${myPnl > 0 ? " green" : myPnl < 0 ? " red" : ""}`}>
                        {myEntry ? `${myPnl >= 0 ? "+" : ""}${myPnl.toFixed(2)}%` : "--"}
                    </div>
                </div>
                <div className="slb-stat-card">
                    <div className="slb-stat-lbl">SEASON ENDS</div>
                    <div className={`slb-stat-val white`}>{timeLeft}</div>
                </div>
            </div>

            {/* ── PHASE BANNER ── */}
            <div className="slb-phase">
                <span className="slb-phase-title">{phaseLabel}</span>
                <span className={`slb-phase-countdown${isUrgent ? " urgent" : ""}`}>
                    Rankings lock in {timeLeft}
                </span>
            </div>

            {/* ── YOUR POSITION BANNER ── */}
            {myEntry && (
                <div className="slb-your-pos">
                    <div className="slb-your-rank">#{myRank}</div>
                    <div className="slb-your-mid">
                        <div className="slb-your-name">
                            {myEntry.display_name ?? "YOU"}
                        </div>
                        {myRank === 1 ? (
                            <div style={{ fontSize: 9, letterSpacing: 3, color: "#FFB800", marginTop: 4 }}>
                                YOU ARE #1
                            </div>
                        ) : (
                            <div className="slb-progress-bar">
                                <div className="slb-progress-fill" style={{ width: `${progressPct}%` }} />
                            </div>
                        )}
                    </div>
                    <div className="slb-your-time">{timeLeft}</div>
                </div>
            )}

            {/* ── TITLE ROW ── */}
            <div className="slb-title-row">
                <span className="slb-live-dot" />
                <span className="slb-title">SEASON {seasonInfo.season_number ?? "?"} LEADERBOARD ({totalParticipants})</span>
            </div>

            {/* ── LOADING STATE ── */}
            {loading && (
                <div className="slb-table" style={{ borderRadius: 6, overflow: "hidden" }}>
                    <SkeletonRows />
                </div>
            )}

            {/* ── ERROR STATE ── */}
            {!loading && error && (
                <div className="slb-error">
                    Failed to load leaderboard.
                    <br />
                    <button className="slb-error-btn" onClick={() => fetchLeaderboard(false)}>RETRY</button>
                </div>
            )}

            {/* ── EMPTY STATE ── */}
            {!loading && !error && displayData.length === 0 && (
                <div className="slb-empty">
                    No traders have joined Season {seasonInfo.season_number ?? "?"} yet.
                </div>
            )}

            {/* ── LEADERBOARD TABLE ── */}
            {!loading && !error && displayData.length > 0 && (
                <table className="slb-table">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>TRADER</th>
                            <th>SCORE</th>
                            <th>P&L %</th>
                            <th>WIN RATE</th>
                            <th>TRADES</th>
                        </tr>
                    </thead>
                    <tbody>
                        {displayData.map((entry, i) => {
                            const rank = entry.rank ?? i + 1;
                            const isCurrentUser = entry.user_id === userId;
                            return (
                                <LeaderboardRow
                                    key={entry.user_id}
                                    entry={{
                                        rank,
                                        user_id: entry.user_id,
                                        display_name: entry.display_name ?? null,
                                        user_tier: entry.user_tier,
                                        nuanced_score: (entry as any).nuanced_score ?? null,
                                        return_pct: entry.return_pct,
                                        win_rate: (entry as any).win_rate ?? null,
                                        trades_count: entry.trades_count,
                                    }}
                                    isCurrentUser={isCurrentUser}
                                    rank={rank}
                                />
                            );
                        })}
                    </tbody>
                    {anonymousCount > 0 && (
                        <tfoot>
                            <tr>
                                <td colSpan={6} className="slb-table-footer">
                                    RANKS 11\u2013{totalParticipants} ANONYMOUS \u00B7 TOP 10 REVEALED AT SEASON END
                                </td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            )}
        </div>
    );
}
