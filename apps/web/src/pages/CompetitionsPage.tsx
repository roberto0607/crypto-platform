import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useCompetitionStore } from "@/stores/competitionStore";

/* ─────────────────────────────────────────
   COMPETE PAGE CSS — Circuit Noir
───────────────────────────────────────── */
const COMPETE_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap');

  :root {
    --cp-g:      #00ff41;
    --cp-g50:    rgba(0,255,65,0.5);
    --cp-g25:    rgba(0,255,65,0.25);
    --cp-g12:    rgba(0,255,65,0.12);
    --cp-g06:    rgba(0,255,65,0.06);
    --cp-red:    #ff3b3b;
    --cp-red12:  rgba(255,59,59,0.12);
    --cp-yellow: #ffd700;
    --cp-yellow12: rgba(255,215,0,0.12);
    --cp-blue:   #3b82f6;
    --cp-purple: #a855f7;
    --cp-orange: #f97316;
    --cp-bg:     #040404;
    --cp-bg2:    #080808;
    --cp-border: rgba(0,255,65,0.16);
    --cp-borderW:rgba(255,255,255,0.06);
    --cp-muted:  rgba(255,255,255,0.3);
    --cp-faint:  rgba(255,255,255,0.05);
    --cp-bebas:  'Bebas Neue', sans-serif;
    --cp-mono:   'Space Mono', monospace;
  }

  .cp-grid { position:fixed;inset:0;pointer-events:none;z-index:0;
    background-image:linear-gradient(rgba(0,255,65,0.02) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,65,0.02) 1px,transparent 1px);
    background-size:48px 48px; }
  .cp-scan { position:fixed;inset:0;pointer-events:none;z-index:1;
    background:repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,0,0,0.05) 3px,rgba(0,0,0,0.05) 4px); }
  .cp-vig  { position:fixed;inset:0;pointer-events:none;z-index:1;
    background:radial-gradient(ellipse 110% 110% at 50% 50%,transparent 30%,rgba(0,0,0,0.58) 100%); }

  .cp-wrap {
    padding:14px 20px 20px;font-family:var(--cp-mono);color:rgba(255,255,255,0.88);
    position:relative;z-index:10;min-height:100%;
  }
  .cp-wrap::-webkit-scrollbar{width:3px}
  .cp-wrap::-webkit-scrollbar-thumb{background:var(--cp-border)}

  /* PAGE HEADER */
  .cp-ph { display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px; }
  .cp-title { font-family:var(--cp-bebas);font-size:26px;color:#fff;letter-spacing:3px;line-height:1; }
  .cp-title span { color:var(--cp-g); }
  .cp-meta { font-size:8px;color:var(--cp-muted);letter-spacing:2px;margin-top:5px; }
  .cp-actions { display:flex;gap:8px; }

  .cp-btn {
    padding:8px 18px;font-family:var(--cp-mono);font-size:9px;font-weight:700;
    letter-spacing:3px;text-transform:uppercase;border:none;cursor:pointer;
    clip-path:polygon(6px 0%,100% 0%,calc(100% - 6px) 100%,0% 100%);
    transition:all 0.2s;position:relative;overflow:hidden;
  }
  .cp-btn::before { content:'';position:absolute;inset:0;
    background:linear-gradient(90deg,transparent,rgba(255,255,255,0.18),transparent);
    transform:translateX(-100%);transition:transform 0.45s; }
  .cp-btn:hover::before { transform:translateX(100%); }
  .cp-btn-p { background:var(--cp-g);color:#000; }
  .cp-btn-p:hover { background:#2dff5c;box-shadow:0 0 24px var(--cp-g25);transform:translateY(-1px); }
  .cp-btn-g { background:transparent;color:var(--cp-muted);border:1px solid var(--cp-borderW); }
  .cp-btn-g:hover { border-color:var(--cp-border);color:#fff;background:var(--cp-g06); }

  /* TIER PROGRESS */
  .cp-tier-card {
    background:var(--cp-bg2);border:1px solid rgba(0,255,65,0.2);
    padding:12px 16px;margin-bottom:8px;position:relative;overflow:hidden;
  }
  .cp-tier-card::before { content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,transparent,var(--cp-g),transparent);opacity:0.55; }
  .cp-tier-top { display:flex;align-items:center;gap:12px;margin-bottom:10px; }
  .cp-tier-lbl { font-size:8px;color:rgba(255,255,255,0.25);letter-spacing:4px;text-transform:uppercase; }
  .cp-tier-badge {
    font-family:var(--cp-bebas);font-size:13px;letter-spacing:3px;padding:3px 12px;
    border:1px solid;clip-path:polygon(5px 0%,100% 0%,calc(100% - 5px) 100%,0% 100%);
  }
  .cp-tier-badge.rookie   { color:#60a5fa;border-color:rgba(96,165,250,0.4);background:rgba(96,165,250,0.08); }
  .cp-tier-badge.trader   { color:var(--cp-g);border-color:var(--cp-border);background:var(--cp-g06); }
  .cp-tier-badge.specialist { color:#a78bfa;border-color:rgba(167,139,250,0.4);background:rgba(167,139,250,0.08); }
  .cp-tier-badge.expert   { color:var(--cp-orange);border-color:rgba(249,115,22,0.4);background:rgba(249,115,22,0.08); }
  .cp-tier-badge.master   { color:var(--cp-yellow);border-color:rgba(255,215,0,0.4);background:var(--cp-yellow12); }
  .cp-tier-badge.legend   { color:#f43f5e;border-color:rgba(244,63,94,0.4);background:rgba(244,63,94,0.08); }

  .cp-tier-track { display:flex;align-items:center;gap:0;position:relative; }
  .cp-tier-track::before {
    content:'';position:absolute;top:50%;left:0;right:0;height:1px;
    background:var(--cp-borderW);transform:translateY(-50%);z-index:0;
  }
  .cp-tier-step { display:flex;flex-direction:column;align-items:center;gap:4px;
    flex:1;position:relative;z-index:1; }
  .cp-tier-node {
    width:14px;height:14px;border:1px solid var(--cp-borderW);
    background:var(--cp-bg);display:flex;align-items:center;justify-content:center;
    clip-path:polygon(3px 0%,100% 0%,calc(100% - 3px) 100%,0% 100%);
    transition:all 0.2s;
  }
  .cp-tier-node.done  { background:var(--cp-g12);border-color:var(--cp-g50); }
  .cp-tier-node.done::after { content:'';width:5px;height:5px;background:var(--cp-g);display:block; }
  .cp-tier-node.current { background:var(--cp-g);border-color:var(--cp-g);
    box-shadow:0 0 12px var(--cp-g25); }
  .cp-tier-node.current::after { content:'';width:5px;height:5px;background:#000;display:block; }
  .cp-tier-node-lbl { font-size:7px;color:rgba(255,255,255,0.2);letter-spacing:2px; }
  .cp-tier-node.done  + .cp-tier-node-lbl,
  .cp-tier-node.current + .cp-tier-node-lbl { color:rgba(255,255,255,0.5); }
  .cp-tier-step.cur .cp-tier-node-lbl { color:var(--cp-g); }

  /* ACTIVE CHALLENGE */
  .cp-challenge {
    background:linear-gradient(135deg,rgba(0,255,65,0.04) 0%,rgba(0,0,0,0) 60%);
    border:1px solid rgba(0,255,65,0.28);padding:14px 18px;
    margin-bottom:8px;position:relative;overflow:hidden;
  }
  .cp-challenge::before { content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,var(--cp-g),transparent);opacity:0.7; }
  .cp-challenge::after { content:'ACTIVE';position:absolute;top:14px;right:20px;
    font-family:var(--cp-bebas);font-size:11px;letter-spacing:4px;
    color:var(--cp-g);opacity:0.3; }
  .cp-ch-top { display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px; }
  .cp-ch-name { font-family:var(--cp-bebas);font-size:18px;color:#fff;letter-spacing:2px; }
  .cp-ch-name span { color:var(--cp-g); }
  .cp-ch-timer { display:flex;flex-direction:column;align-items:flex-end;gap:2px; }
  .cp-ch-timer-val { font-family:var(--cp-bebas);font-size:20px;color:var(--cp-yellow);letter-spacing:2px; }
  .cp-ch-timer-lbl { font-size:7px;color:rgba(255,215,0,0.4);letter-spacing:3px; }
  .cp-ch-pills { display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px; }
  .cp-pill {
    font-size:7px;letter-spacing:2px;padding:3px 10px;text-transform:uppercase;
    border:1px solid var(--cp-borderW);color:var(--cp-muted);
    display:flex;align-items:center;gap:6px;
  }
  .cp-pill::before { content:'\u258C';color:var(--cp-g);font-size:8px; }
  .cp-ch-cta {
    display:flex;align-items:center;gap:12px;
  }
  .cp-join-btn {
    padding:9px 22px;font-family:var(--cp-mono);font-size:9px;font-weight:700;
    letter-spacing:4px;text-transform:uppercase;border:none;cursor:pointer;
    background:var(--cp-g);color:#000;
    clip-path:polygon(8px 0%,100% 0%,calc(100% - 8px) 100%,0% 100%);
    transition:all 0.2s;position:relative;overflow:hidden;
  }
  .cp-join-btn::before { content:'';position:absolute;inset:0;
    background:linear-gradient(90deg,transparent,rgba(255,255,255,0.25),transparent);
    transform:translateX(-100%);transition:transform 0.5s; }
  .cp-join-btn:hover::before { transform:translateX(100%); }
  .cp-join-btn:hover { background:#2dff5c;box-shadow:0 0 28px var(--cp-g25);transform:translateY(-1px); }
  .cp-join-btn.error { background:var(--cp-red);animation:cpShake 0.3s ease; }
  .cp-join-btn:disabled { opacity:0.6;cursor:not-allowed; }
  @keyframes cpShake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-4px)} 75%{transform:translateX(4px)} }
  .cp-join-hint { font-size:8px;color:rgba(255,255,255,0.18);letter-spacing:2px; }
  .cp-joined-hero {
    padding:9px 22px;font-family:var(--cp-mono);font-size:9px;font-weight:700;
    letter-spacing:4px;text-transform:uppercase;border:1px solid rgba(0,255,65,0.3);
    color:rgba(0,255,65,0.6);cursor:pointer;
    clip-path:polygon(8px 0%,100% 0%,calc(100% - 8px) 100%,0% 100%);
    background:transparent;transition:all 0.2s;
  }
  .cp-joined-hero:hover { background:var(--cp-g06);border-color:var(--cp-g50); }

  /* SECTION HEADER */
  .cp-sect-hdr {
    display:flex;align-items:center;justify-content:space-between;
    margin-bottom:8px;margin-top:2px;
  }
  .cp-sect-title {
    font-family:var(--cp-bebas);font-size:18px;color:rgba(255,255,255,0.7);letter-spacing:3px;
    display:flex;align-items:center;gap:10px;
  }
  .cp-sect-title::before { content:'\u258C';color:var(--cp-g);font-size:14px; }

  /* FILTER BAR */
  .cp-filters { display:flex;gap:0;border:1px solid var(--cp-borderW);overflow:hidden; }
  .cp-filter {
    padding:5px 12px;font-size:8px;letter-spacing:3px;color:var(--cp-muted);
    border-right:1px solid var(--cp-borderW);transition:all 0.15s;font-family:var(--cp-mono);
    cursor:pointer;
  }
  .cp-filter:last-child { border-right:none; }
  .cp-filter.active { background:var(--cp-g06);color:var(--cp-g); }
  .cp-filter:not(.active):hover { color:#fff;background:var(--cp-faint); }

  /* COMPETITION TABLE */
  .cp-table-wrap {
    background:var(--cp-bg2);border:1px solid rgba(0,255,65,0.18);
    position:relative;overflow:hidden;
  }
  .cp-table-wrap::before { content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,transparent,var(--cp-g),transparent);opacity:0.55; }

  .cp-tbl { width:100%;border-collapse:collapse; }
  .cp-tbl th {
    font-size:7px;color:rgba(255,255,255,0.18);letter-spacing:3px;
    text-transform:uppercase;padding:8px 14px;
    border-bottom:1px solid var(--cp-borderW);text-align:left;font-weight:400;
  }
  .cp-tbl th:not(:first-child):not(:nth-child(2)) { text-align:right; }
  .cp-tbl td { padding:9px 14px;font-size:10px;border-bottom:1px solid var(--cp-faint);
    transition:background 0.12s; }
  .cp-tbl tr:last-child td { border-bottom:none; }
  .cp-tbl tr:hover td { background:var(--cp-g06); }
  .cp-tbl tr.cp-my-row td { background:rgba(0,255,65,0.04); }
  .cp-tbl tr.cp-my-row:hover td { background:rgba(0,255,65,0.08); }

  /* tier badge inline */
  .cp-t { font-family:var(--cp-bebas);font-size:11px;letter-spacing:2px;
    padding:2px 8px;border:1px solid;
    clip-path:polygon(3px 0%,100% 0%,calc(100% - 3px) 100%,0% 100%); }
  .cp-t.rookie    { color:#60a5fa;border-color:rgba(96,165,250,0.3);background:rgba(96,165,250,0.07); }
  .cp-t.trader    { color:var(--cp-g);border-color:rgba(0,255,65,0.3);background:var(--cp-g06); }
  .cp-t.specialist{ color:#a78bfa;border-color:rgba(167,139,250,0.3);background:rgba(167,139,250,0.07); }
  .cp-t.expert    { color:var(--cp-orange);border-color:rgba(249,115,22,0.3);background:rgba(249,115,22,0.07); }
  .cp-t.master    { color:var(--cp-yellow);border-color:rgba(255,215,0,0.3);background:var(--cp-yellow12); }
  .cp-t.legend    { color:#f43f5e;border-color:rgba(244,63,94,0.3);background:rgba(244,63,94,0.07); }

  /* you badge */
  .cp-you {
    font-size:7px;color:#000;background:var(--cp-g);letter-spacing:2px;
    padding:1px 6px;font-weight:700;margin-left:6px;
    clip-path:polygon(3px 0%,100% 0%,calc(100% - 3px) 100%,0% 100%);
  }

  .cp-comp-name { font-size:11px;color:rgba(255,255,255,0.7);letter-spacing:1px; }
  .cp-comp-name.mine { color:#fff; }

  .cp-status { font-size:8px;letter-spacing:2px;display:flex;align-items:center;gap:5px; }
  .cp-status.active { color:var(--cp-g); }
  .cp-status.upcoming { color:rgba(255,255,255,0.35); }
  .cp-status.ended { color:rgba(255,255,255,0.2); }
  .cp-sdot { width:5px;height:5px;border-radius:50%;flex-shrink:0; }
  .cp-sdot.active { background:var(--cp-g);animation:cpulse 1.5s ease-in-out infinite;
    box-shadow:0 0 6px var(--cp-g); }
  .cp-sdot.upcoming { background:rgba(255,255,255,0.2); }
  .cp-sdot.ended { background:rgba(255,255,255,0.1); }

  .cp-date { font-size:9px;color:rgba(255,255,255,0.35);letter-spacing:1px; }
  .cp-bal { font-family:var(--cp-bebas);font-size:16px;color:rgba(255,255,255,0.5);letter-spacing:1px; }

  .cp-enter-btn {
    font-size:8px;color:var(--cp-g);letter-spacing:2px;
    border:1px solid var(--cp-border);padding:4px 12px;
    transition:all 0.15s;font-family:var(--cp-mono);cursor:pointer;
    clip-path:polygon(4px 0%,100% 0%,calc(100% - 4px) 100%,0% 100%);
    background:transparent;
  }
  .cp-enter-btn:hover { background:var(--cp-g06);box-shadow:0 0 12px var(--cp-g12); }
  .cp-enter-btn.error { border-color:var(--cp-red);color:var(--cp-red);animation:cpShake 0.3s ease; }
  .cp-entered-badge {
    font-size:8px;color:rgba(0,255,65,0.5);letter-spacing:2px;
    border:1px solid rgba(0,255,65,0.2);padding:4px 12px;
    clip-path:polygon(4px 0%,100% 0%,calc(100% - 4px) 100%,0% 100%);
  }

  @keyframes cpulse { 0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(0,255,65,0.4)}
    50%{opacity:0.7;box-shadow:0 0 0 4px transparent} }

  .cp-fu { animation:cpFadeUp 0.35s ease both; }
  @keyframes cpFadeUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
  .cp-d1{animation-delay:0.05s} .cp-d2{animation-delay:0.1s}
  .cp-d3{animation-delay:0.16s} .cp-d4{animation-delay:0.22s}

  .cp-loading {
    display:flex;align-items:center;justify-content:center;
    padding:40px;font-size:8px;color:rgba(255,255,255,0.15);letter-spacing:4px;
    text-transform:uppercase;
  }
  .cp-empty {
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    padding:40px;gap:7px;
  }
  .cp-empty-icon { font-size:22px;opacity:0.12; }
  .cp-empty-lbl { font-size:8px;color:rgba(255,255,255,0.13);letter-spacing:4px;text-transform:uppercase; }
`;

/* ── TIER CONFIG ── */
const TIERS = [
  { key: "ROOKIE",     label: "RO", full: "ROOKIE" },
  { key: "TRADER",     label: "TR", full: "TRADER" },
  { key: "SPECIALIST", label: "SP", full: "SPECIALIST" },
  { key: "EXPERT",     label: "EX", full: "EXPERT" },
  { key: "MASTER",     label: "MA", full: "MASTER" },
  { key: "LEGEND",     label: "LE", full: "LEGEND" },
];

const NEXT_TIER: Record<string, string> = {
  ROOKIE: "TRADER", TRADER: "SPECIALIST", SPECIALIST: "EXPERT",
  EXPERT: "MASTER", MASTER: "LEGEND", LEGEND: "LEGEND",
};

type StatusFilter = "UPCOMING" | "ACTIVE" | "ENDED" | "ALL";
type TypeFilter = "WEEKLY" | "CUSTOM";
type FilterKey = StatusFilter | TypeFilter;

const FILTERS: FilterKey[] = ["UPCOMING", "ACTIVE", "ENDED", "ALL", "WEEKLY", "CUSTOM"];

/* ── COUNTDOWN HOOK ── */
function useCountdown(targetDate: string | null) {
  const [remaining, setRemaining] = useState("");
  useEffect(() => {
    if (!targetDate) { setRemaining(""); return; }
    const tick = () => {
      const diff = new Date(targetDate).getTime() - Date.now();
      if (diff <= 0) { setRemaining("ENDED"); return; }
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      setRemaining(`${d}D ${String(h).padStart(2, "0")}H ${String(m).padStart(2, "0")}M`);
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [targetDate]);
  return remaining;
}

/* ─────────────────────────────────────────
   MAIN COMPETE COMPONENT
───────────────────────────────────────── */
export default function CompetitionsPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<FilterKey>("ACTIVE");
  const [clock, setClock] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState(false);
  const [joiningRowId, setJoiningRowId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const {
    competitions, listLoading, fetchCompetitions,
    currentWeekly, currentWeeklyJoined, userTier, weeklyLoading,
    fetchCurrentWeekly, fetchUserBadges,
    join,
  } = useCompetitionStore();

  // Inject CSS
  useEffect(() => {
    const id = "tradr-compete-css";
    if (!document.getElementById(id)) {
      const s = document.createElement("style");
      s.id = id;
      s.textContent = COMPETE_CSS;
      document.head.appendChild(s);
    }
  }, []);

  // Clock
  useEffect(() => {
    const tick = () => {
      const n = new Date();
      const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
      const mos = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
      const p = (v: number) => String(v).padStart(2, "0");
      setClock(`SEASON 01 \u00B7 ${days[n.getDay()]} ${p(n.getDate())} ${mos[n.getMonth()]} ${n.getFullYear()} \u00B7 ${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())} EST`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Fetch weekly + badges on mount
  useEffect(() => {
    fetchCurrentWeekly();
    fetchUserBadges();
  }, [fetchCurrentWeekly, fetchUserBadges]);

  // Fetch competitions list — server-side filtering
  const loadComps = useCallback(() => {
    const isStatusFilter = filter === "UPCOMING" || filter === "ACTIVE" || filter === "ENDED";
    const isTypeFilter = filter === "WEEKLY" || filter === "CUSTOM";
    fetchCompetitions({
      status: isStatusFilter ? filter : undefined,
      competition_type: isTypeFilter ? filter : undefined,
      limit: 50,
    });
  }, [filter, fetchCompetitions]);

  useEffect(() => {
    loadComps();
  }, [loadComps]);

  const countdown = useCountdown(currentWeekly?.end_at ?? null);

  // ── Join handlers ──
  const handleJoinWeekly = async () => {
    if (!currentWeekly || joining) return;
    setJoining(true);
    setJoinError(false);
    try {
      await join(currentWeekly.id);
      await fetchCurrentWeekly();
    } catch {
      setJoinError(true);
      setTimeout(() => setJoinError(false), 1000);
    } finally {
      setJoining(false);
    }
  };

  const handleJoinRow = async (compId: string) => {
    if (joiningRowId) return;
    setJoiningRowId(compId);
    setRowError(null);
    try {
      await join(compId);
      loadComps();
      await fetchCurrentWeekly();
    } catch {
      setRowError(compId);
      setTimeout(() => setRowError(null), 1000);
    } finally {
      setJoiningRowId(null);
    }
  };

  // ── Determine which comps user has joined ──
  const myCompIds = new Set<string>();
  if (currentWeekly && currentWeeklyJoined) myCompIds.add(currentWeekly.id);

  // Tier index for progress
  const tierIdx = TIERS.findIndex((t) => t.key === userTier.toUpperCase());
  const tierLower = userTier.toLowerCase();
  const nextTier = NEXT_TIER[userTier.toUpperCase()] ?? "TRADER";

  // Active challenge name
  const challengeName = currentWeekly?.name ?? `Weekly \u00B7 ${userTier} \u00B7 Current Week`;

  return (
    <div className="cp-wrap">
      <div className="cp-grid" /><div className="cp-scan" /><div className="cp-vig" />

      {/* PAGE HEADER */}
      <div className="cp-ph cp-fu">
        <div>
          <div className="cp-title">COM<span>PETE</span></div>
          <div className="cp-meta">{clock}</div>
        </div>
        <div className="cp-actions">
          <button className="cp-btn cp-btn-g">{"\u2139"} HOW IT WORKS</button>
          <button
            className="cp-btn cp-btn-p"
            onClick={() => currentWeekly && navigate(`/competitions/${currentWeekly.id}`)}
          >
            {"\u25B6"} VIEW LEADERBOARD
          </button>
        </div>
      </div>

      {/* TIER PROGRESS */}
      <div className="cp-tier-card cp-fu cp-d1">
        <div className="cp-tier-top">
          <span className="cp-tier-lbl">YOUR TIER</span>
          <span className={`cp-tier-badge ${tierLower}`}>{userTier.toUpperCase()}</span>
          <span style={{ fontSize: 8, color: "rgba(255,255,255,0.18)", letterSpacing: 2, marginLeft: "auto" }}>
            COMPLETE 5 TRADES TO ADVANCE {"\u2192"} {nextTier}
          </span>
        </div>
        <div className="cp-tier-track">
          {TIERS.map((t, i) => {
            const isCurrent = i === tierIdx;
            const isDone = i < tierIdx;
            return (
              <div key={t.key} className={`cp-tier-step${isCurrent ? " cur" : ""}`}>
                <div className={`cp-tier-node${isDone ? " done" : isCurrent ? " current" : ""}`} />
                <div className="cp-tier-node-lbl">{t.label}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ACTIVE CHALLENGE */}
      {currentWeekly ? (
        <div className="cp-challenge cp-fu cp-d2">
          <div className="cp-ch-top">
            <div>
              <div className="cp-ch-name">
                {challengeName.split("\u00B7").map((part, i) =>
                  i === 1 ? <span key={i}>{"\u00B7"}<span>{part}</span>{"\u00B7"}</span> : <span key={i}>{i > 1 ? "" : ""}{part}</span>
                )}
              </div>
            </div>
            <div className="cp-ch-timer">
              <div className="cp-ch-timer-val">{countdown || "..."}</div>
              <div className="cp-ch-timer-lbl">{currentWeekly.status === "UPCOMING" ? "STARTS IN" : "ENDS IN"}</div>
            </div>
          </div>
          <div className="cp-ch-pills">
            <span className="cp-pill">${Number(currentWeekly.starting_balance_usd).toLocaleString()} STARTING BALANCE</span>
            <span className="cp-pill">BTC {"\u00B7"} ETH {"\u00B7"} SOL</span>
            <span className="cp-pill">MIN 5 TRADES TO QUALIFY</span>
            <span className="cp-pill">TOP 20% RANK UP</span>
          </div>
          <div className="cp-ch-cta">
            {currentWeeklyJoined ? (
              <button
                className="cp-joined-hero"
                onClick={() => navigate(`/competitions/${currentWeekly.id}`)}
              >
                {"\u2713"} ENTERED {"\u2014"} VIEW LEADERBOARD
              </button>
            ) : (
              <>
                <button
                  className={`cp-join-btn${joinError ? " error" : ""}`}
                  onClick={handleJoinWeekly}
                  disabled={joining}
                >
                  {joining ? "JOINING..." : `${"\u25B9"} JOIN THIS WEEK'S CHALLENGE`}
                </button>
                <span className="cp-join-hint">FREE TO ENTER {"\u00B7"} NO REAL MONEY</span>
              </>
            )}
          </div>
        </div>
      ) : !weeklyLoading ? (
        <div className="cp-challenge cp-fu cp-d2" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
          <div style={{ fontSize: 8, color: "rgba(255,255,255,0.15)", letterSpacing: 3, textTransform: "uppercase", textAlign: "center", padding: 20 }}>
            Next weekly competition starts Monday at 00:00 UTC
          </div>
        </div>
      ) : null}

      {/* ALL COMPETITIONS */}
      <div className="cp-sect-hdr cp-fu cp-d3">
        <div className="cp-sect-title">All Competitions</div>
        <div className="cp-filters">
          {FILTERS.map((f) => (
            <div key={f} className={`cp-filter${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>{f}</div>
          ))}
        </div>
      </div>

      <div className="cp-table-wrap cp-fu cp-d4">
        {listLoading ? (
          <div className="cp-loading">LOADING COMPETITIONS...</div>
        ) : competitions.length === 0 ? (
          <div className="cp-empty">
            <div className="cp-empty-icon">{"\u25C8"}</div>
            <div className="cp-empty-lbl">No {filter.toLowerCase()} competitions</div>
          </div>
        ) : (
          <table className="cp-tbl">
            <thead>
              <tr>
                <th>Tier</th>
                <th>Name</th>
                <th style={{ textAlign: "center" }}>Status</th>
                <th>Starts</th>
                <th>Ends</th>
                <th>Balance</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {competitions.map((c, i) => {
                const isMine = myCompIds.has(c.id) || (c.competition_type === "WEEKLY" && c.tier?.toUpperCase() === userTier.toUpperCase() && currentWeeklyJoined);
                const tierKey = c.tier?.toLowerCase() ?? "";
                const statusKey = c.status.toLowerCase() as "active" | "upcoming" | "ended";
                const isJoiningThis = joiningRowId === c.id;
                const hasRowError = rowError === c.id;
                const canJoin = c.status === "ACTIVE" || c.status === "UPCOMING";

                return (
                  <tr
                    key={c.id}
                    className={isMine ? "cp-my-row" : ""}
                    style={{ animationDelay: `${i * 0.04}s`, cursor: "pointer" }}
                    onClick={() => navigate(`/competitions/${c.id}`)}
                  >
                    <td>
                      {c.competition_type === "WEEKLY" && tierKey ? (
                        <span className={`cp-t ${tierKey}`}>{(c.tier ?? "").toUpperCase()}</span>
                      ) : (
                        <span style={{ fontSize: 8, color: "rgba(255,255,255,0.2)", letterSpacing: 2 }}>CUSTOM</span>
                      )}
                    </td>
                    <td>
                      <span className={`cp-comp-name${isMine ? " mine" : ""}`}>{c.name}</span>
                      {isMine && <span className="cp-you">YOU</span>}
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <span className={`cp-status ${statusKey}`}>
                        <span className={`cp-sdot ${statusKey}`} />
                        {c.status}
                      </span>
                    </td>
                    <td><span className="cp-date">{new Date(c.start_at).toLocaleDateString()}</span></td>
                    <td><span className="cp-date">{new Date(c.end_at).toLocaleDateString()}</span></td>
                    <td><span className="cp-bal">${Number(c.starting_balance_usd).toLocaleString()}</span></td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {isMine ? (
                        <span className="cp-entered-badge">{"\u2713"} ENTERED</span>
                      ) : canJoin ? (
                        <button
                          className={`cp-enter-btn${hasRowError ? " error" : ""}`}
                          onClick={() => handleJoinRow(c.id)}
                          disabled={isJoiningThis}
                        >
                          {isJoiningThis ? "..." : `${"\u25B9"} ENTER`}
                        </button>
                      ) : (
                        <span style={{ fontSize: 8, color: "rgba(255,255,255,0.1)", letterSpacing: 2 }}>
                          {c.status === "ENDED" ? "ENDED" : "\u2014"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
