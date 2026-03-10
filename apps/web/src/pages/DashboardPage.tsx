import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import { subDays, startOfDay, format } from "date-fns";
import { useCompetitionStore } from "@/stores/competitionStore";
import { useAppStore } from "@/stores/appStore";
import { useAuthStore } from "@/stores/authStore";
import { getSummary, getEquityCurve } from "@/api/endpoints/portfolio";
import { getJournal, getJournalSummary } from "@/api/endpoints/journal";
import { getPositions } from "@/api/endpoints/analytics";
import { getLeaderboard } from "@/api/endpoints/competitions";
import { placeOrder } from "@/api/endpoints/trading";
import { formatUsd } from "@/lib/decimal";
import type { PortfolioSummary, PortfolioSnapshot, Position, TradingPair } from "@/types/api";
import type { LeaderboardEntry } from "@/api/endpoints/competitions";

/* ─────────────────────────────────────────
   INJECT FONTS + GLOBAL STYLES ONCE
───────────────────────────────────────── */
const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap');

  :root {
    --g:      #00ff41;
    --g50:    rgba(0,255,65,0.5);
    --g25:    rgba(0,255,65,0.25);
    --g12:    rgba(0,255,65,0.12);
    --g06:    rgba(0,255,65,0.06);
    --g03:    rgba(0,255,65,0.03);
    --red:    #ff3b3b;
    --red12:  rgba(255,59,59,0.12);
    --yellow: #ffd700;
    --bg:     #040404;
    --bg2:    #080808;
    --bg3:    #0c0c0c;
    --border: rgba(0,255,65,0.16);
    --borderW:rgba(255,255,255,0.06);
    --text:   rgba(255,255,255,0.88);
    --muted:  rgba(255,255,255,0.3);
    --faint:  rgba(255,255,255,0.05);
    --sb:     220px;
    --tb:     52px;
    --bebas:  'Bebas Neue', sans-serif;
    --mono:   'Space Mono', monospace;
  }

  /* ── CUSTOM CURSOR ── */
  #tradr-cursor {
    position: fixed; width: 18px; height: 18px; z-index: 99999;
    pointer-events: none; transform: translate(-50%,-50%);
    transition: transform 0.1s ease, opacity 0.2s;
  }
  #tradr-cursor::before,#tradr-cursor::after {
    content:''; position:absolute; background:var(--g);
  }
  #tradr-cursor::before { left:50%;top:0;width:1px;height:100%;transform:translateX(-50%); }
  #tradr-cursor::after  { top:50%;left:0;height:1px;width:100%;transform:translateY(-50%); }
  #tradr-cdot {
    position:fixed;width:3px;height:3px;background:var(--g);border-radius:50%;
    z-index:99999;pointer-events:none;transform:translate(-50%,-50%);
    box-shadow:0 0 6px var(--g);
  }

  /* ── PAGE HEADER ── */
  .t-ph {
    display:flex;align-items:flex-start;justify-content:space-between;
    margin-bottom:20px;
  }
  .t-ph-title { font-family:var(--bebas);font-size:30px;color:#fff;letter-spacing:3px;line-height:1; }
  .t-ph-title span { color:var(--g); }
  .t-ph-meta { font-size:8px;color:var(--muted);letter-spacing:2px;margin-top:5px; }
  .t-ph-actions { display:flex;gap:8px; }

  /* ── BUTTONS ── */
  .t-btn {
    padding:8px 18px;font-family:var(--mono);font-size:9px;font-weight:700;
    letter-spacing:3px;text-transform:uppercase;border:none;
    clip-path:polygon(6px 0%,100% 0%,calc(100% - 6px) 100%,0% 100%);
    transition:all 0.2s;position:relative;overflow:hidden;
  }
  .t-btn::before {
    content:'';position:absolute;inset:0;
    background:linear-gradient(90deg,transparent,rgba(255,255,255,0.18),transparent);
    transform:translateX(-100%);transition:transform 0.45s;
  }
  .t-btn:hover::before { transform:translateX(100%); }
  .t-btn-p { background:var(--g);color:#000; }
  .t-btn-p:hover { background:#2dff5c;box-shadow:0 0 24px var(--g25);transform:translateY(-1px); }
  .t-btn-g { background:transparent;color:var(--muted);border:1px solid var(--borderW); }
  .t-btn-g:hover { border-color:var(--border);color:#fff;background:var(--g06); }

  /* ── CARD ── */
  .t-card {
    background:var(--bg2);border:1px solid rgba(0,255,65,0.2);
    position:relative;overflow:hidden;
    transition:border-color 0.2s;
  }
  .t-card:hover { border-color:rgba(0,255,65,0.32); }
  .t-card::before {
    content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,transparent 0%,var(--g) 40%,var(--g) 60%,transparent 100%);
    opacity:0.55;
  }
  .t-ch {
    display:flex;align-items:center;justify-content:space-between;
    padding:11px 16px;border-bottom:1px solid var(--borderW);
  }
  .t-ch-title {
    font-size:8px;color:rgba(255,255,255,0.28);letter-spacing:4px;
    text-transform:uppercase;display:flex;align-items:center;gap:7px;
  }
  .t-ch-title::before { content:'▌';color:var(--g);font-size:10px; }
  .t-ch-right { font-size:8px;color:var(--muted);letter-spacing:2px;display:flex;gap:10px;align-items:center; }
  .t-ch-btn {
    font-size:8px;color:var(--g);letter-spacing:2px;
    border:1px solid var(--border);padding:2px 8px;
    transition:all 0.15s;
  }
  .t-ch-btn:hover { background:var(--g06); }

  /* ── STAT CARDS ── */
  .t-stats { display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px; }
  .t-sc {
    background:var(--bg2);border:1px solid rgba(0,255,65,0.2);
    padding:18px 20px;position:relative;overflow:hidden;
    transition:border-color 0.2s,transform 0.2s;
  }
  .t-sc:hover { border-color:rgba(0,255,65,0.35);transform:translateY(-2px); }
  .t-sc::before {
    content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,transparent,var(--g),transparent);opacity:0.5;
  }
  .t-sc-label {
    font-size:8px;color:rgba(255,255,255,0.26);letter-spacing:4px;
    text-transform:uppercase;margin-bottom:11px;
  }
  .t-sc-val {
    font-family:var(--bebas);font-size:36px;line-height:1;letter-spacing:1px;
  }
  .t-sc-val.wh { color:#fff; }
  .t-sc-val.gr { color:var(--g);text-shadow:0 0 20px var(--g25); }
  .t-sc-val.rd { color:var(--red); }
  .t-sc-val.dm { color:rgba(255,255,255,0.18); }
  .t-sc-sub {
    font-size:8px;color:rgba(255,255,255,0.22);letter-spacing:1px;margin-top:7px;
    display:flex;align-items:center;gap:5px;
  }
  .t-sc-sub .up { color:var(--g); }
  .t-sc-sub .dn { color:var(--red); }
  .t-sc-ghost {
    position:absolute;bottom:8px;right:12px;
    font-family:var(--bebas);font-size:56px;
    color:rgba(255,255,255,0.022);line-height:1;pointer-events:none;
  }

  /* ── MID ROW ── */
  .t-mid { display:grid;grid-template-columns:1fr 268px;gap:10px;margin-bottom:12px; }

  /* chart */
  .t-chart-wrap { padding:4px 2px 2px; }
  canvas.t-chart { display:block;width:100%; }

  /* today pnl */
  .t-pnl-body {
    flex:1;display:flex;flex-direction:column;align-items:center;
    justify-content:center;padding:20px 20px 0;gap:4px;
  }
  .t-pnl-big { font-family:var(--bebas);font-size:56px;line-height:1;color:rgba(255,255,255,0.1); }
  .t-pnl-lbl { font-size:7px;color:rgba(255,255,255,0.14);letter-spacing:3px;margin-top:2px; }
  .t-pnl-hint { font-size:8px;color:rgba(0,255,65,0.3);letter-spacing:2px;text-align:center;margin-top:10px;line-height:2; }
  .t-pnl-meta { display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--borderW);margin-top:auto; }
  .t-pnl-mi { padding:12px 14px;text-align:center; }
  .t-pnl-mi:first-child { border-right:1px solid var(--borderW); }
  .t-pnl-mv { font-family:var(--bebas);font-size:20px;color:rgba(255,255,255,0.2); }
  .t-pnl-ml { font-size:7px;color:rgba(255,255,255,0.12);letter-spacing:2px;margin-top:2px; }

  /* ── BOT ROW ── */
  .t-bot { display:grid;grid-template-columns:1fr 256px 210px;gap:10px; }

  /* trades */
  .t-tbl { width:100%;border-collapse:collapse; }
  .t-tbl th {
    font-size:7px;color:rgba(255,255,255,0.18);letter-spacing:3px;
    text-transform:uppercase;padding:9px 16px;border-bottom:1px solid var(--borderW);
    text-align:left;font-weight:400;
  }
  .t-tbl td { padding:10px 16px;font-size:10px;border-bottom:1px solid var(--faint); }
  .t-tbl tr:last-child td { border-bottom:none; }
  .t-tbl tr:hover td { background:var(--g06); }
  .t-sym { font-family:var(--bebas);font-size:17px;color:#fff; }
  .t-side-b { font-size:7px;color:var(--g);letter-spacing:2px;border:1px solid rgba(0,255,65,0.3);padding:1px 5px; }
  .t-side-s { font-size:7px;color:var(--red);letter-spacing:2px;border:1px solid rgba(255,59,59,0.3);padding:1px 5px; }
  .t-pnl-pos { color:var(--g); }
  .t-pnl-neg { color:var(--red); }
  .t-dim { color:rgba(255,255,255,0.4); }
  .t-xs { font-size:9px;color:rgba(255,255,255,0.18); }

  /* empty state shared */
  .t-empty {
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    padding:28px 16px;gap:7px;
  }
  .t-empty-icon { font-size:24px;opacity:0.15; }
  .t-empty-lbl { font-size:8px;color:rgba(255,255,255,0.14);letter-spacing:4px;text-transform:uppercase; }
  .t-empty-cta { font-size:8px;color:rgba(0,255,65,0.35);letter-spacing:3px;margin-top:2px; }

  /* leaderboard */
  .t-lb-row {
    display:flex;align-items:center;gap:9px;
    padding:8px 14px;border-bottom:1px solid var(--faint);
    transition:background 0.15s;
  }
  .t-lb-row:hover { background:var(--g06); }
  .t-lb-row:last-child { border-bottom:none; }
  .t-lb-num { font-family:var(--bebas);font-size:17px;color:rgba(255,255,255,0.1);width:18px;flex-shrink:0; }
  .t-lb-num.gd { color:var(--yellow);text-shadow:0 0 8px rgba(255,215,0,0.4); }
  .t-lb-av {
    width:22px;height:22px;flex-shrink:0;border:1px solid var(--border);
    background:var(--g06);display:flex;align-items:center;justify-content:center;
    font-size:7px;font-weight:700;color:var(--g);
    clip-path:polygon(3px 0%,100% 0%,calc(100% - 3px) 100%,0% 100%);
  }
  .t-lb-av.ghost { background:rgba(255,255,255,0.02);border-style:none; }
  .t-lb-av.open { border-style:dashed;color:rgba(0,255,65,0.3);animation:tpulse 2s ease-in-out infinite; }
  .t-lb-handle { flex:1;font-size:9px;color:rgba(255,255,255,0.45);letter-spacing:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
  .t-lb-ghost-h { flex:1;height:6px;background:rgba(255,255,255,0.04);border-radius:1px; }
  .t-lb-ghost-p { width:26px;height:10px;background:rgba(255,255,255,0.03);border-radius:1px; }
  .t-lb-pnl { font-family:var(--bebas);font-size:13px;color:var(--g);flex-shrink:0; }
  .t-lb-open { animation:tpulserow 2.5s ease-in-out infinite; }
  @keyframes tpulserow { 0%,100%{background:rgba(0,255,65,0.025)} 50%{background:rgba(0,255,65,0.065)} }
  .t-lb-foot {
    padding:9px 14px;border-top:1px solid var(--borderW);
    font-size:7px;color:rgba(0,255,65,0.22);letter-spacing:3px;text-align:center;text-transform:uppercase;
  }

  /* quick trade */
  .t-qt-body { padding:12px 14px;display:flex;flex-direction:column;gap:9px; }
  .t-at { display:flex;gap:0;border:1px solid var(--borderW);overflow:hidden; }
  .t-at-tab {
    flex:1;padding:7px 0;text-align:center;font-size:9px;letter-spacing:2px;color:var(--muted);
    border-right:1px solid var(--borderW);transition:all 0.15s;font-family:var(--mono);
  }
  .t-at-tab:last-child { border-right:none; }
  .t-at-tab.active { background:var(--g06);color:var(--g); }
  .t-at-tab:hover:not(.active) { color:#fff;background:var(--faint); }
  .t-qt-pr { display:flex;align-items:baseline;justify-content:space-between;padding:2px 0; }
  .t-qt-price { font-family:var(--bebas);font-size:28px;color:#fff;letter-spacing:1px; }
  .t-qt-chg { font-size:9px;letter-spacing:1px; }
  .t-qt-inp {
    border:1px solid var(--borderW);display:flex;align-items:center;
    background:rgba(0,0,0,0.35);transition:border-color 0.2s;
  }
  .t-qt-inp:focus-within { border-color:var(--g50); box-shadow:0 0 12px rgba(0,255,65,0.06); }
  .t-qt-lbl {
    font-size:7px;color:var(--muted);letter-spacing:2px;padding:0 10px;
    border-right:1px solid var(--borderW);flex-shrink:0;
  }
  .t-qt-inp input {
    flex:1;background:transparent;border:none;outline:none;
    font-family:var(--mono);font-size:11px;color:#fff;
    padding:9px 10px;letter-spacing:1px;
  }
  .t-qt-inp input::placeholder { color:rgba(255,255,255,0.14); }
  .t-qt-btns { display:grid;grid-template-columns:1fr 1fr;gap:6px; }
  .t-qt-b,.t-qt-s {
    padding:10px;border:none;font-family:var(--mono);
    font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;
    transition:all 0.2s;
    clip-path:polygon(6px 0%,100% 0%,calc(100% - 6px) 100%,0% 100%);
  }
  .t-qt-b { background:var(--g);color:#000; }
  .t-qt-b:hover { background:#2dff5c;box-shadow:0 0 20px var(--g25); }
  .t-qt-s { background:var(--red12);color:var(--red);border:1px solid rgba(255,59,59,0.25); }
  .t-qt-s:hover { background:rgba(255,59,59,0.18);box-shadow:0 0 16px rgba(255,59,59,0.18); }
  .t-qt-bal { font-size:7px;color:rgba(255,255,255,0.16);letter-spacing:2px;text-align:center; }
  .t-qt-bal span { color:rgba(255,255,255,0.38); }

  /* animations */
  @keyframes tpulse {
    0%,100%{opacity:1;box-shadow:0 0 0 0 var(--g25)}
    50%{opacity:0.6;box-shadow:0 0 0 4px transparent}
  }
  .t-fade-up { animation:tfadeUp 0.4s ease both; }
  @keyframes tfadeUp { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
  .d1{animation-delay:0.05s} .d2{animation-delay:0.1s}
  .d3{animation-delay:0.15s} .d4{animation-delay:0.2s}
  .d5{animation-delay:0.26s} .d6{animation-delay:0.34s}
`;

// ── Types ──
interface ClosedTrade {
  id: string;
  pair_symbol: string;
  direction: "LONG" | "SHORT";
  entry_avg_price: string;
  exit_avg_price: string;
  net_pnl: string;
  exit_at: string;
}

interface JournalSummaryData {
  totalTrades: number;
  winRate: string;
}

/* ─────────────────────────────────────────
   CURSOR (injected into body)
───────────────────────────────────────── */
function useCursor() {
  useEffect(() => {
    let cur = document.getElementById("tradr-cursor");
    let dot = document.getElementById("tradr-cdot");
    if (!cur) {
      cur = document.createElement("div"); cur.id = "tradr-cursor";
      dot = document.createElement("div"); dot!.id = "tradr-cdot";
      document.body.appendChild(cur);
      document.body.appendChild(dot!);
    }
    let mx = 0, my = 0, cx = 0, cy = 0;
    const onMove = (e: MouseEvent) => { mx = e.clientX; my = e.clientY; };
    document.addEventListener("mousemove", onMove);
    let raf: number;
    const loop = () => {
      cx += (mx - cx) * 0.18; cy += (my - cy) * 0.18;
      if (cur) { cur.style.left = mx + "px"; cur.style.top = my + "px"; }
      if (dot) { dot.style.left = cx + "px"; dot.style.top = cy + "px"; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const hoverIn  = () => { if (cur) cur.style.transform = "translate(-50%,-50%) scale(2)"; };
    const hoverOut = () => { if (cur) cur.style.transform = "translate(-50%,-50%) scale(1)"; };
    const addHover = () => document.querySelectorAll("button,.t-ni,.t-at-tab,.t-ch-btn").forEach(el => {
      el.addEventListener("mouseenter", hoverIn);
      el.addEventListener("mouseleave", hoverOut);
    });
    const obs = new MutationObserver(addHover);
    obs.observe(document.body, { childList: true, subtree: true });
    addHover();
    return () => {
      document.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(raf);
      obs.disconnect();
      document.getElementById("tradr-cursor")?.remove();
      document.getElementById("tradr-cdot")?.remove();
    };
  }, []);
}

/* ─────────────────────────────────────────
   SUB-COMPONENTS
───────────────────────────────────────── */
function EquityChart({ snapshots }: { snapshots: Array<{ ts: number; equity: number }> }) {
  const ref = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const W = canvas.offsetWidth;
    const H = 148;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // grid
    ctx.strokeStyle = "rgba(0,255,65,0.04)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo(0, H / 4 * i); ctx.lineTo(W, H / 4 * i); ctx.stroke();
    }
    for (let i = 1; i < 8; i++) {
      ctx.beginPath(); ctx.moveTo(W / 8 * i, 0); ctx.lineTo(W / 8 * i, H); ctx.stroke();
    }

    if (snapshots.length === 0) {
      // ── EMPTY STATE ──
      const baseY = H * 0.58;
      ctx.setLineDash([5, 7]);
      ctx.strokeStyle = "rgba(0,255,65,0.22)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, baseY); ctx.lineTo(W, baseY); ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "rgba(0,255,65,0.3)";
      ctx.font = "8px Space Mono, monospace";
      ctx.fillText("$100,000 \u2014 starting capital", 14, baseY - 7);

      const grad = ctx.createLinearGradient(W * 0.45, 0, W, 0);
      grad.addColorStop(0, "rgba(0,255,65,0)");
      grad.addColorStop(1, "rgba(0,255,65,0.04)");
      ctx.fillStyle = grad;
      ctx.fillRect(W * 0.45, 0, W * 0.55, H);

      ctx.fillStyle = "rgba(255,255,255,0.07)";
      ctx.font = "700 10px Space Mono, monospace";
      ctx.textAlign = "center";
      ctx.fillText("\u25B8 MAKE YOUR FIRST TRADE TO START TRACKING", W / 2, H / 2 + 4);
      ctx.textAlign = "left";
      return;
    }

    // ── REAL DATA ──
    const pts = snapshots;
    const minTs = pts[0]!.ts;
    const maxTs = pts[pts.length - 1]!.ts;
    const tsRange = maxTs - minTs || 1;
    const minEq = Math.min(...pts.map(p => p.equity));
    const maxEq = Math.max(...pts.map(p => p.equity));
    const eqRange = maxEq - minEq || 1;
    const pad = 14;

    // Gradient fill
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x = ((pts[i]!.ts - minTs) / tsRange) * W;
      const y = pad + (1 - (pts[i]!.equity - minEq) / eqRange) * (H - 2 * pad);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, 0, 0, H);
    gradient.addColorStop(0, "rgba(0,255,65,0.12)");
    gradient.addColorStop(1, "rgba(0,255,65,0)");
    ctx.fillStyle = gradient;
    ctx.fill();

    // Line
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x = ((pts[i]!.ts - minTs) / tsRange) * W;
      const y = pad + (1 - (pts[i]!.equity - minEq) / eqRange) * (H - 2 * pad);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#00ff41";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Dot at latest point
    const latest = pts[pts.length - 1]!;
    const dotX = ((latest.ts - minTs) / tsRange) * W;
    const dotY = pad + (1 - (latest.equity - minEq) / eqRange) * (H - 2 * pad);
    ctx.beginPath();
    ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#00ff41";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(dotX, dotY, 6, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0,255,65,0.25)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Latest value label
    ctx.fillStyle = "rgba(0,255,65,0.8)";
    ctx.font = "700 9px Space Mono, monospace";
    ctx.textAlign = "right";
    ctx.fillText(
      `$${latest.equity.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
      W - 8, dotY - 6,
    );
    ctx.textAlign = "left";
  }, [snapshots]);

  useEffect(() => {
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [draw]);

  return <canvas ref={ref} className="t-chart" height={148} />;
}

function StatCard({ label, value, sub, ghost, cls = "dm", delay = "" }: {
  label: string;
  value: string;
  sub?: string;
  ghost?: string;
  cls?: string;
  delay?: string;
}) {
  return (
    <div className={`t-sc t-fade-up ${delay}`}>
      <div className="t-sc-label">{label}</div>
      <div className={`t-sc-val ${cls}`}>{value}</div>
      {sub && <div className="t-sc-sub" dangerouslySetInnerHTML={{ __html: sub }} />}
      {ghost && <div className="t-sc-ghost">{ghost}</div>}
    </div>
  );
}

function QuickTrade({ pairs, cashBalance, onTrade }: {
  pairs: TradingPair[];
  cashBalance: string;
  onTrade: (pairId: string, side: "BUY" | "SELL", qty: string) => Promise<void>;
}) {
  const [pairIdx, setPairIdx] = useState(0);
  const [amt, setAmt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const pair = pairs[pairIdx] ?? null;
  const price = pair?.last_price ? parseFloat(pair.last_price) : 0;
  const priceDisplay = price > 0
    ? `$${price.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
    : "\u2014";

  async function handleTrade(side: "BUY" | "SELL") {
    if (!pair || !amt || submitting || price <= 0) return;
    setSubmitting(true);
    setResult(null);
    try {
      const qty = (parseFloat(amt) / price).toFixed(8);
      await onTrade(pair.id, side, qty);
      setResult(`${side} filled`);
      setAmt("");
      setTimeout(() => setResult(null), 3000);
    } catch {
      setResult("Order failed");
      setTimeout(() => setResult(null), 3000);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="t-card t-fade-up d6" style={{ display: "flex", flexDirection: "column" }}>
      <div className="t-ch">
        <span className="t-ch-title">Quick Trade</span>
        <span style={{ fontSize: 8, color: "rgba(0,255,65,0.4)", letterSpacing: 2 }}>PAPER</span>
      </div>
      <div className="t-qt-body">
        <div className="t-at">
          {pairs.slice(0, 3).map((p, i) => (
            <div
              key={p.id}
              className={`t-at-tab${pairIdx === i ? " active" : ""}`}
              onClick={() => setPairIdx(i)}
            >{p.symbol.split("/")[0]}</div>
          ))}
        </div>
        <div className="t-qt-pr">
          <span className="t-qt-price">{priceDisplay}</span>
        </div>
        <div className="t-qt-inp">
          <span className="t-qt-lbl">AMT $</span>
          <input
            type="number"
            placeholder="0.00"
            value={amt}
            onChange={e => setAmt(e.target.value)}
          />
        </div>
        {result && (
          <div style={{
            fontSize: 9, letterSpacing: 1, textAlign: "center",
            color: result.includes("failed") ? "var(--red)" : "var(--g)",
          }}>
            {result}
          </div>
        )}
        <div className="t-qt-btns">
          <button className="t-qt-b" onClick={() => handleTrade("BUY")} disabled={submitting}>
            &#9650; BUY
          </button>
          <button className="t-qt-s" onClick={() => handleTrade("SELL")} disabled={submitting}>
            &#9660; SELL
          </button>
        </div>
        <div className="t-qt-bal">BALANCE &nbsp;<span>{cashBalance}</span></div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────
   MAIN DASHBOARD COMPONENT
───────────────────────────────────────── */
export default function DashboardPage() {
  const pairs = useAppStore((s) => s.pairs);
  const userId = useAuthStore((s) => s.user?.id);
  const { myCompetitions, fetchMyCompetitions } = useCompetitionStore();

  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [snapshots, setSnapshots] = useState<PortfolioSnapshot[]>([]);
  const [recentTrades, setRecentTrades] = useState<ClosedTrade[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [journalStats, setJournalStats] = useState<JournalSummaryData | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [activeCompName, setActiveCompName] = useState<string | null>(null);
  const [clock, setClock] = useState("");
  const [loading, setLoading] = useState(true);

  useCursor();

  // Inject global CSS on mount, remove on unmount
  useEffect(() => {
    const id = "tradr-global-css";
    let style = document.getElementById(id) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = id;
      style.textContent = GLOBAL_CSS;
      document.head.appendChild(style);
    }
    return () => {
      document.getElementById(id)?.remove();
    };
  }, []);

  // Live clock
  useEffect(() => {
    const tick = () => {
      const n = new Date();
      const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
      const mos = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
      const pad = (v: number) => String(v).padStart(2, "0");
      setClock(`SEASON 01 \u00B7 ${days[n.getDay()]} ${pad(n.getDate())} ${mos[n.getMonth()]} ${n.getFullYear()} \u00B7 ${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())} EST`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Load dashboard data
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const results = await Promise.allSettled([
        getSummary(),
        getEquityCurve({ from: subDays(new Date(), 7).toISOString() }),
        getJournal({ limit: 5 }),
        getPositions(),
        getJournalSummary(),
      ]);
      if (cancelled) return;
      const [pRes, eqRes, jRes, posRes, jsRes] = results;
      if (pRes.status === "fulfilled") setPortfolio(pRes.value.data.summary);
      if (eqRes.status === "fulfilled") setSnapshots(eqRes.value.data.snapshots);
      if (jRes.status === "fulfilled") setRecentTrades(jRes.value.data.trades ?? []);
      if (posRes.status === "fulfilled") setPositions(posRes.value.data.positions);
      if (jsRes.status === "fulfilled") {
        const s = jsRes.value.data.summary as unknown as JournalSummaryData;
        setJournalStats(s);
      }
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // Load competitions + leaderboard
  useEffect(() => { fetchMyCompetitions(); }, [fetchMyCompetitions]);

  useEffect(() => {
    const active = (myCompetitions ?? []).find(
      (c) => c.competition_status === "ACTIVE" && c.status === "ACTIVE",
    );
    if (active) {
      setActiveCompName(active.competition_name);
      getLeaderboard(active.competition_id, { limit: 5 })
        .then((res) => setLeaderboard(res.data.leaderboard ?? (res.data as any).data ?? []))
        .catch(() => {});
    }
  }, [myCompetitions]);

  // ── Derived values ──
  const activePairs = pairs.filter(p => p.is_active);

  const equityData = snapshots.map(s => ({
    ts: new Date(s.ts).getTime(),
    equity: parseFloat(s.equity_quote),
  }));

  // Today's P&L
  let todayPnl: number | null = null;
  if (portfolio && snapshots.length > 0) {
    const todayStart = startOfDay(new Date()).getTime();
    const todaySnaps = snapshots.filter(s => new Date(s.ts).getTime() >= todayStart);
    if (todaySnaps.length > 0) {
      const startEq = parseFloat(todaySnaps[0]!.equity_quote);
      todayPnl = parseFloat(portfolio.equity_quote) - startEq;
    }
  }

  const todayStart = startOfDay(new Date());
  const todayTradeCount = recentTrades.filter(t => new Date(t.exit_at) >= todayStart).length;

  const unrealizedPnl = positions.reduce((sum, p) => sum + parseFloat(p.unrealized_pnl_quote), 0);
  const netPnl = portfolio ? parseFloat(portfolio.net_pnl_quote) : null;

  // Stat card display values
  const portfolioValue = portfolio ? formatUsd(portfolio.equity_quote) : "$100,000";
  const availableBalance = portfolio ? formatUsd(portfolio.cash_quote) : "$100,000";
  const cashDisplay = portfolio ? formatUsd(portfolio.cash_quote) : "$100,000.00";

  async function handleQuickTrade(pairId: string, side: "BUY" | "SELL", qty: string) {
    await placeOrder({ pairId, side, type: "MARKET", qty }, crypto.randomUUID());
  }

  if (loading) {
    return (
      <div className="t-empty" style={{ padding: "60px 0" }}>
        <div className="t-empty-icon" style={{ animation: "tpulse 1.5s ease-in-out infinite" }}>&#x25C8;</div>
        <div className="t-empty-lbl">Loading dashboard</div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "var(--mono)" }}>
      {/* PAGE HEADER */}
      <div className="t-ph t-fade-up">
        <div>
          <div className="t-ph-title">DASH<span>BOARD</span></div>
          <div className="t-ph-meta">{clock || "SEASON 01"}</div>
        </div>
        <div className="t-ph-actions">
          <Link to="/journal" className="t-btn t-btn-g" style={{ textDecoration: "none" }}>{"\u2193"} JOURNAL</Link>
          <Link to="/trade" className="t-btn t-btn-p" style={{ textDecoration: "none" }}>{"\u25B8"} TRADE NOW</Link>
        </div>
      </div>

      {/* STAT CARDS */}
      <div className="t-stats">
        <StatCard
          label="Portfolio Value"
          value={portfolioValue}
          sub={portfolio
            ? `${positions.length} position${positions.length !== 1 ? "s" : ""} <span style="color:rgba(0,255,65,0.5)">\u00B7</span> ${formatUsd(portfolio.net_pnl_quote)} all time`
            : `Starting capital &nbsp;<span style="color:rgba(0,255,65,0.5)">\u00B7</span>&nbsp; 0 positions`
          }
          ghost="$"
          cls="wh"
          delay="d1"
        />
        <StatCard
          label="Available Balance"
          value={availableBalance}
          sub="Ready to deploy"
          ghost="&cent;"
          cls="gr"
          delay="d2"
        />
        <StatCard
          label="Unrealized PnL"
          value={positions.length > 0 ? formatUsd(unrealizedPnl.toFixed(2)) : "\u2014\u2014"}
          sub={`Open positions: &nbsp;<span style="color:rgba(255,255,255,0.3)">${positions.length}</span>`}
          ghost="~"
          cls={positions.length > 0 ? (unrealizedPnl >= 0 ? "gr" : "rd") : "dm"}
          delay="d3"
        />
        <StatCard
          label="Net PnL"
          value={netPnl !== null && (netPnl !== 0 || recentTrades.length > 0) ? formatUsd(netPnl.toFixed(2)) : "\u2014\u2014"}
          sub={`Closed trades: &nbsp;<span style="color:rgba(255,255,255,0.3)">${journalStats?.totalTrades ?? 0}</span>`}
          ghost="&Sigma;"
          cls={netPnl !== null && netPnl !== 0 ? (netPnl >= 0 ? "gr" : "rd") : "dm"}
          delay="d4"
        />
      </div>

      {/* MID ROW */}
      <div className="t-mid t-fade-up d5">
        {/* EQUITY CHART */}
        <div className="t-card">
          <div className="t-ch">
            <span className="t-ch-title">7-Day Equity Curve</span>
            <div className="t-ch-right">
              <span style={{ color: "rgba(255,255,255,0.1)", letterSpacing: 2, fontSize: 8 }}>7D</span>
              <Link to="/portfolio" className="t-ch-btn" style={{ textDecoration: "none" }}>EXPAND {"\u2197"}</Link>
            </div>
          </div>
          <div className="t-chart-wrap">
            <EquityChart snapshots={equityData} />
          </div>
        </div>

        {/* TODAY PNL */}
        <div className="t-card" style={{ display: "flex", flexDirection: "column" }}>
          <div className="t-ch">
            <span className="t-ch-title">Today's P&L</span>
            <span style={{ fontSize: 8, color: "rgba(0,255,65,0.3)", letterSpacing: 2 }}>EST</span>
          </div>
          <div className="t-pnl-body">
            {todayPnl !== null ? (
              <>
                <div className="t-pnl-big" style={{
                  color: todayPnl > 0 ? "var(--g)" : todayPnl < 0 ? "var(--red)" : undefined,
                }}>
                  {todayPnl >= 0 ? "+" : ""}{formatUsd(todayPnl.toFixed(2))}
                </div>
                <div className="t-pnl-lbl">
                  {todayTradeCount > 0 ? `${todayTradeCount} TRADE${todayTradeCount > 1 ? "S" : ""} TODAY` : "NO TRADES TODAY"}
                </div>
              </>
            ) : (
              <>
                <div className="t-pnl-big">{"\u2014"}</div>
                <div className="t-pnl-lbl">NO TRADES TODAY</div>
                <div className="t-pnl-hint">{"\u25B8"} FIRST TRADE<br />WRITES HISTORY</div>
              </>
            )}
          </div>
          <div className="t-pnl-meta">
            <div className="t-pnl-mi">
              <div className="t-pnl-mv" style={journalStats ? { color: "rgba(255,255,255,0.6)" } : undefined}>
                {journalStats?.totalTrades ?? 0}
              </div>
              <div className="t-pnl-ml">Trades</div>
            </div>
            <div className="t-pnl-mi">
              <div className="t-pnl-mv" style={journalStats ? { color: "rgba(255,255,255,0.6)" } : undefined}>
                {journalStats ? `${journalStats.winRate}%` : "\u2014%"}
              </div>
              <div className="t-pnl-ml">Win Rate</div>
            </div>
          </div>
        </div>
      </div>

      {/* BOTTOM ROW */}
      <div className="t-bot t-fade-up d6">
        {/* RECENT TRADES */}
        <div className="t-card">
          <div className="t-ch">
            <span className="t-ch-title">Recent Trades</span>
            <div className="t-ch-right">
              <span className="t-ch-btn">TODAY</span>
              <Link to="/journal" className="t-ch-btn" style={{ textDecoration: "none" }}>VIEW ALL {"\u2192"}</Link>
            </div>
          </div>
          {recentTrades.length === 0 ? (
            <div className="t-empty">
              <div className="t-empty-icon">{"\u25C8"}</div>
              <div className="t-empty-lbl">No closed trades yet</div>
              <div className="t-empty-cta">{"\u25B8"} OPEN A POSITION TO BEGIN</div>
            </div>
          ) : (
            <table className="t-tbl">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Side</th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th>PnL</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {recentTrades.map((t) => {
                  const pnl = parseFloat(t.net_pnl);
                  return (
                    <tr key={t.id}>
                      <td><span className="t-sym">{t.pair_symbol.replace("/", "")}</span></td>
                      <td>
                        <span className={t.direction === "LONG" ? "t-side-b" : "t-side-s"}>
                          {t.direction === "LONG" ? "BUY" : "SELL"}
                        </span>
                      </td>
                      <td className="t-dim">{formatUsd(t.entry_avg_price)}</td>
                      <td className="t-dim">{formatUsd(t.exit_avg_price)}</td>
                      <td className={pnl >= 0 ? "t-pnl-pos" : "t-pnl-neg"}>
                        {pnl >= 0 ? "+" : ""}{formatUsd(t.net_pnl)}
                      </td>
                      <td className="t-xs">{format(new Date(t.exit_at), "HH:mm")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* MINI LEADERBOARD */}
        <div className="t-card">
          <div className="t-ch">
            <span className="t-ch-title">Arena {activeCompName ? `\u00B7 ${activeCompName}` : "\u00B7 S01"}</span>
            <span style={{ fontSize: 8, color: "rgba(255,255,255,0.14)", letterSpacing: 2 }}>
              {leaderboard.length > 0 ? `${leaderboard.length} TRADERS` : "0 TRADERS"}
            </span>
          </div>
          {leaderboard.length === 0 ? (
            <>
              {/* Rank 1 — open slot */}
              <div className="t-lb-row t-lb-open" style={{ borderLeft: "2px solid var(--g)" }}>
                <div className="t-lb-num gd">1</div>
                <div className="t-lb-av open">?</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 8, color: "var(--g)", letterSpacing: 2 }}>UNCLAIMED</div>
                  <div style={{ fontSize: 7, color: "rgba(0,255,65,0.35)", letterSpacing: 1, marginTop: 2 }}>YOURS TO TAKE</div>
                </div>
                <div style={{ fontSize: 10, color: "rgba(0,255,65,0.2)" }}>{"\u2014"}%</div>
              </div>
              {/* Ghost rows */}
              {[2, 3, 4, 5].map((n, i) => (
                <div key={n} className="t-lb-row" style={{ opacity: 0.3 - i * 0.065, borderBottom: n === 5 ? "none" : undefined }}>
                  <div className="t-lb-num">{n}</div>
                  <div className="t-lb-av ghost" />
                  <div className="t-lb-ghost-h" style={{ width: [90, 70, 55, 75][i] }} />
                  <div className="t-lb-ghost-p" />
                </div>
              ))}
              <div className="t-lb-foot">
                <Link to="/competitions" style={{ color: "inherit", textDecoration: "none" }}>
                  Join a competition to start
                </Link>
              </div>
            </>
          ) : (
            <>
              {leaderboard.map((entry) => {
                const isMe = entry.user_id === userId;
                const retPct = parseFloat(entry.return_pct);
                return (
                  <div
                    key={entry.user_id}
                    className="t-lb-row"
                    style={isMe ? { background: "rgba(0,255,65,0.06)", borderLeft: "2px solid var(--g)" } : undefined}
                  >
                    <div className={`t-lb-num${entry.rank === 1 ? " gd" : ""}`}>{entry.rank}</div>
                    <div className="t-lb-av">
                      {(entry.display_name || "??").slice(0, 2).toUpperCase()}
                    </div>
                    <div className="t-lb-handle">
                      {entry.display_name}{isMe ? " \u2605" : ""}
                    </div>
                    <div className="t-lb-pnl" style={{ color: retPct >= 0 ? "var(--g)" : "var(--red)" }}>
                      {retPct >= 0 ? "+" : ""}{retPct.toFixed(2)}%
                    </div>
                  </div>
                );
              })}
              <div className="t-lb-foot">
                <Link to="/competitions" style={{ color: "inherit", textDecoration: "none" }}>
                  View full leaderboard {"\u2192"}
                </Link>
              </div>
            </>
          )}
        </div>

        {/* QUICK TRADE */}
        <QuickTrade
          pairs={activePairs}
          cashBalance={cashDisplay}
          onTrade={handleQuickTrade}
        />
      </div>

      {/* YOUR COMPETITIONS */}
      {(myCompetitions ?? []).filter((c) => c.competition_status === "ACTIVE" && c.status === "ACTIVE").length > 0 && (
        <div className="t-card t-fade-up" style={{ marginTop: 10 }}>
          <div className="t-ch">
            <span className="t-ch-title">Your Competitions</span>
            <Link to="/competitions" className="t-ch-btn" style={{ textDecoration: "none" }}>VIEW ALL {"\u2192"}</Link>
          </div>
          {(myCompetitions ?? [])
            .filter((c) => c.competition_status === "ACTIVE" && c.status === "ACTIVE")
            .map((c) => (
              <Link
                key={c.competition_id}
                to={`/competitions/${c.competition_id}`}
                className="t-lb-row"
                style={{ textDecoration: "none", display: "flex", alignItems: "center", justifyContent: "space-between" }}
              >
                <span style={{ fontSize: 10, color: "rgba(255,255,255,0.8)", letterSpacing: 1, fontFamily: "var(--mono)" }}>
                  {c.competition_name}
                </span>
                <span style={{ fontSize: 8, color: "rgba(255,255,255,0.2)", letterSpacing: 1, fontFamily: "var(--mono)" }}>
                  Ends {format(new Date(c.end_at), "MMM d")}
                </span>
              </Link>
            ))}
        </div>
      )}
    </div>
  );
}
