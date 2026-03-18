import { useState, useEffect } from "react";
import { useAuthStore } from "@/stores/authStore";
import { useCompetitionStore } from "@/stores/competitionStore";
import { getMatchHistory, type Match } from "@/api/endpoints/matches";

const PROFILE_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap');

  .pf-wrap {
    --pf-g: #00ff41; --pf-red: #ff3b3b; --pf-orange: #FF6B00;
    --pf-gold: #FFD700; --pf-bg: #040404; --pf-bg2: #080808;
    --pf-border: rgba(0,255,65,0.16); --pf-borderW: rgba(255,255,255,0.06);
    --pf-muted: rgba(255,255,255,0.3); --pf-faint: rgba(255,255,255,0.05);
    --pf-bebas: 'Bebas Neue', sans-serif; --pf-mono: 'Space Mono', monospace;
    padding:16px 24px 24px;font-family:var(--pf-mono);color:rgba(255,255,255,0.88);
    position:relative;z-index:10;min-height:100%;
  }

  /* Header */
  .pf-header { display:flex;align-items:center;gap:20px;margin-bottom:24px; }
  .pf-avatar {
    width:64px;height:64px;border-radius:50%;border:2px solid var(--pf-orange);
    display:flex;align-items:center;justify-content:center;
    font-family:var(--pf-bebas);font-size:28px;color:var(--pf-orange);
    background:rgba(255,107,0,0.06);
  }
  .pf-name { font-family:var(--pf-bebas);font-size:32px;letter-spacing:4px;color:#fff; }
  .pf-tier-row { display:flex;align-items:center;gap:10px;margin-top:4px; }
  .pf-tier-badge {
    font-family:var(--pf-bebas);font-size:14px;letter-spacing:3px;
    padding:3px 12px;display:inline-block;
  }
  .pf-tier-ROOKIE { color:var(--pf-g);border:1px solid rgba(0,255,65,0.3);background:rgba(0,255,65,0.06); }
  .pf-tier-PRO { color:#3b82f6;border:1px solid rgba(59,130,246,0.3);background:rgba(59,130,246,0.06); }
  .pf-tier-ELITE { color:#a855f7;border:1px solid rgba(168,85,247,0.3);background:rgba(168,85,247,0.06); }
  .pf-tier-LEGEND { color:var(--pf-gold);border:1px solid rgba(255,215,0,0.3);background:rgba(255,215,0,0.06); }
  .pf-elo { font-family:var(--pf-bebas);font-size:18px;color:var(--pf-orange);letter-spacing:2px; }

  /* ELO progress bar */
  .pf-elo-bar-wrap { margin:16px 0;max-width:400px; }
  .pf-elo-bar-labels { display:flex;justify-content:space-between;font-size:8px;color:var(--pf-muted);letter-spacing:2px;margin-bottom:4px; }
  .pf-elo-bar-bg {
    height:6px;background:rgba(255,255,255,0.06);border:1px solid var(--pf-borderW);position:relative;
  }
  .pf-elo-bar-fill { position:absolute;top:0;left:0;bottom:0;background:var(--pf-orange);transition:width 0.3s; }

  /* Stats grid */
  .pf-stats {
    display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px;
  }
  .pf-stat {
    border:1px solid var(--pf-borderW);background:rgba(255,255,255,0.02);padding:16px;text-align:center;
  }
  .pf-stat-val { font-family:var(--pf-bebas);font-size:28px;letter-spacing:2px;color:#fff; }
  .pf-stat-lbl { font-size:8px;color:var(--pf-muted);letter-spacing:3px;margin-top:4px; }

  /* Section label */
  .pf-section { font-size:9px;color:var(--pf-muted);letter-spacing:4px;margin:24px 0 12px;border-bottom:1px solid var(--pf-borderW);padding-bottom:6px; }

  /* Badges */
  .pf-badges { display:flex;gap:10px;flex-wrap:wrap; }
  .pf-badge-item {
    border:1px solid var(--pf-gold);background:rgba(255,215,0,0.04);padding:8px 16px;
    text-align:center;
  }
  .pf-badge-icon { font-size:20px;margin-bottom:4px; }
  .pf-badge-name { font-size:9px;color:var(--pf-gold);letter-spacing:2px; }
  .pf-badge-meta { font-size:7px;color:var(--pf-muted);letter-spacing:1px;margin-top:2px; }

  /* Table */
  .pf-tbl { width:100%;border-collapse:collapse; }
  .pf-tbl th {
    font-size:8px;color:rgba(255,255,255,0.4);letter-spacing:3px;text-transform:uppercase;
    padding:8px 12px;border-bottom:1px solid var(--pf-borderW);text-align:left;
  }
  .pf-tbl td { padding:10px 12px;font-size:11px;border-bottom:1px solid var(--pf-faint); }

  .pf-empty { text-align:center;padding:24px;color:var(--pf-muted);font-size:11px;letter-spacing:2px; }
`;

// ELO tier thresholds
const TIER_THRESHOLDS = [
    { tier: "ROOKIE", min: 0, max: 999 },
    { tier: "PRO", min: 1000, max: 1499 },
    { tier: "ELITE", min: 1500, max: 1999 },
    { tier: "LEGEND", min: 2000, max: 3000 },
];

function getTierForElo(elo: number): { tier: string; min: number; max: number; progress: number } {
    for (const t of TIER_THRESHOLDS) {
        if (elo >= t.min && elo <= t.max) {
            const range = t.max - t.min;
            const progress = range > 0 ? ((elo - t.min) / range) * 100 : 100;
            return { ...t, progress };
        }
    }
    const last = TIER_THRESHOLDS[TIER_THRESHOLDS.length - 1]!;
    return { ...last, progress: 100 };
}

export default function ProfilePage() {
    const user = useAuthStore((s) => s.user);
    const userTier = useCompetitionStore((s) => s.userTier);
    const userBadges = useCompetitionStore((s) => s.userBadges);
    const fetchUserBadges = useCompetitionStore((s) => s.fetchUserBadges);

    const [matchHistory, setMatchHistory] = useState<Match[]>([]);
    const [stats, setStats] = useState({ total: 0, wins: 0, losses: 0, bestStreak: 0, currentStreak: 0 });
    const [elo, setElo] = useState(800);

    useEffect(() => {
        fetchUserBadges();
        loadMatchStats();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    async function loadMatchStats() {
        try {
            const { data } = await getMatchHistory({ limit: 100 });
            setMatchHistory(data.matches);

            const userId = user?.id;
            let wins = 0, losses = 0, bestStreak = 0, currentStreak = 0, streak = 0;
            for (const m of data.matches) {
                if (m.winner_id === userId) {
                    wins++;
                    streak++;
                    if (streak > bestStreak) bestStreak = streak;
                } else if (m.winner_id) {
                    losses++;
                    currentStreak = currentStreak || streak;
                    streak = 0;
                }
            }
            if (!currentStreak) currentStreak = streak;
            setStats({ total: data.total, wins, losses, bestStreak, currentStreak });

            // Get ELO from the most recent match's player info
            if (data.matches.length > 0) {
                const latest = data.matches[0]!;
                const isChallenger = latest.challenger_id === userId;
                setElo(isChallenger ? latest.challenger_elo : latest.opponent_elo);
            }
        } catch { /* ignore */ }
    }

    const displayName = user?.displayName || user?.email?.split("@")[0] || "trader";
    const initials = displayName.slice(0, 2).toUpperCase();
    const tier = getTierForElo(elo);
    const winRate = stats.total > 0 ? ((stats.wins / stats.total) * 100).toFixed(1) : "0.0";
    const nextTierName = TIER_THRESHOLDS.find((t) => t.min > elo)?.tier ?? "MAX";

    return (
        <>
            <style>{PROFILE_CSS}</style>
            <div className="pf-wrap">
                {/* HEADER */}
                <div className="pf-header">
                    <div className="pf-avatar">{initials}</div>
                    <div>
                        <div className="pf-name">{displayName.toUpperCase()}</div>
                        <div className="pf-tier-row">
                            <span className={`pf-tier-badge pf-tier-${userTier}`}>{userTier}</span>
                            <span className="pf-elo">{elo} ELO</span>
                        </div>
                    </div>
                </div>

                {/* ELO PROGRESS BAR */}
                <div className="pf-elo-bar-wrap">
                    <div className="pf-elo-bar-labels">
                        <span>{tier.tier} ({tier.min})</span>
                        <span>{nextTierName} ({tier.max + 1})</span>
                    </div>
                    <div className="pf-elo-bar-bg">
                        <div className="pf-elo-bar-fill" style={{ width: `${tier.progress}%` }} />
                    </div>
                </div>

                {/* STATS */}
                <div className="pf-stats">
                    <div className="pf-stat">
                        <div className="pf-stat-val">{stats.total}</div>
                        <div className="pf-stat-lbl">TOTAL MATCHES</div>
                    </div>
                    <div className="pf-stat">
                        <div className="pf-stat-val" style={{ color: "var(--pf-g)" }}>{winRate}%</div>
                        <div className="pf-stat-lbl">WIN RATE</div>
                    </div>
                    <div className="pf-stat">
                        <div className="pf-stat-val" style={{ color: "var(--pf-orange)" }}>{stats.bestStreak}</div>
                        <div className="pf-stat-lbl">BEST STREAK</div>
                    </div>
                    <div className="pf-stat">
                        <div className="pf-stat-val">{stats.currentStreak}</div>
                        <div className="pf-stat-lbl">CURRENT STREAK</div>
                    </div>
                </div>

                {/* BADGES */}
                <div className="pf-section">BADGES</div>
                {userBadges.length === 0 ? (
                    <div className="pf-empty">NO BADGES EARNED YET</div>
                ) : (
                    <div className="pf-badges">
                        {userBadges.map((b) => (
                            <div key={b.id} className="pf-badge-item">
                                <div className="pf-badge-icon">{b.badge_type === "WEEKLY_CHAMPION" ? "\u2655" : "\u2606"}</div>
                                <div className="pf-badge-name">{b.badge_type.replace(/_/g, " ")}</div>
                                <div className="pf-badge-meta">{b.tier} {"\u00B7"} {b.week_id}</div>
                            </div>
                        ))}
                    </div>
                )}

                {/* MATCH HISTORY */}
                <div className="pf-section">MATCH HISTORY</div>
                {matchHistory.length === 0 ? (
                    <div className="pf-empty">NO MATCHES YET {"\u2014"} CHALLENGE SOMEONE IN THE ARENA</div>
                ) : (
                    <table className="pf-tbl">
                        <thead>
                            <tr>
                                <th>OPPONENT</th>
                                <th>RESULT</th>
                                <th>P&L</th>
                                <th>ELO</th>
                                <th>DATE</th>
                            </tr>
                        </thead>
                        <tbody>
                            {matchHistory.slice(0, 20).map((m) => {
                                const isChallenger = m.challenger_id === user?.id;
                                const opponentName = isChallenger ? (m.opponent_name ?? "?") : (m.challenger_name ?? "?");
                                const yourPnl = isChallenger ? m.challenger_pnl_pct : m.opponent_pnl_pct;
                                const won = m.winner_id === user?.id;
                                const lost = m.winner_id && m.winner_id !== user?.id;
                                const delta = m.elo_delta ?? 0;
                                return (
                                    <tr key={m.id}>
                                        <td style={{ color: "rgba(255,255,255,0.7)" }}>{opponentName}</td>
                                        <td>
                                            {won
                                                ? <span style={{ color: "var(--pf-g)", fontSize: 9, letterSpacing: 2 }}>WIN</span>
                                                : lost
                                                    ? <span style={{ color: "var(--pf-red)", fontSize: 9, letterSpacing: 2 }}>LOSS</span>
                                                    : <span style={{ color: "var(--pf-gold)", fontSize: 9, letterSpacing: 2 }}>DRAW</span>}
                                        </td>
                                        <td style={{ color: parseFloat(yourPnl ?? "0") >= 0 ? "var(--pf-g)" : "var(--pf-red)" }}>
                                            {yourPnl ? (parseFloat(yourPnl) >= 0 ? "+" : "") + parseFloat(yourPnl).toFixed(2) + "%" : "--"}
                                        </td>
                                        <td style={{ color: won ? "var(--pf-g)" : lost ? "var(--pf-red)" : "var(--pf-muted)" }}>
                                            {won ? `+${delta}` : lost ? `-${delta}` : "0"}
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
    );
}
