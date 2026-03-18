import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "@/stores/appStore";
import { useTradingStore } from "@/stores/tradingStore";
import { getSummary, getEquityCurve, getPerformance } from "@/api/endpoints/portfolio";
import { getJournal, getJournalSummary } from "@/api/endpoints/journal";
import { subDays, subMonths, format } from "date-fns";
import Decimal from "decimal.js-light";
import type {
  PortfolioSummary,
  PortfolioSnapshot,
  PerformanceSummary,
} from "@/types/api";

/* ─────────────────────────────────────────
   PORTFOLIO PAGE CSS — Circuit Noir
───────────────────────────────────────── */
const PORTFOLIO_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap');

  :root {
    --pf-g:      #00ff41;
    --pf-g50:    rgba(0,255,65,0.5);
    --pf-g25:    rgba(0,255,65,0.25);
    --pf-g12:    rgba(0,255,65,0.12);
    --pf-g06:    rgba(0,255,65,0.06);
    --pf-g03:    rgba(0,255,65,0.03);
    --pf-red:    #ff3b3b;
    --pf-red12:  rgba(255,59,59,0.12);
    --pf-yellow: #ffd700;
    --pf-bg:     #040404;
    --pf-bg2:    #080808;
    --pf-bg3:    #0c0c0c;
    --pf-border: rgba(0,255,65,0.16);
    --pf-borderW:rgba(255,255,255,0.06);
    --pf-text:   rgba(255,255,255,0.88);
    --pf-muted:  rgba(255,255,255,0.3);
    --pf-faint:  rgba(255,255,255,0.05);
    --pf-bebas:  'Bebas Neue', sans-serif;
    --pf-mono:   'Space Mono', monospace;
  }

  /* ── BG LAYERS ── */
  .pf-grid {
    position:fixed;inset:0;pointer-events:none;z-index:0;
    background-image:
      linear-gradient(rgba(0,255,65,0.02) 1px,transparent 1px),
      linear-gradient(90deg,rgba(0,255,65,0.02) 1px,transparent 1px);
    background-size:48px 48px;
  }
  .pf-scan {
    position:fixed;inset:0;pointer-events:none;z-index:1;
    background:repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,0,0,0.055) 3px,rgba(0,0,0,0.055) 4px);
  }
  .pf-vig {
    position:fixed;inset:0;pointer-events:none;z-index:1;
    background:radial-gradient(ellipse 110% 110% at 50% 50%,transparent 30%,rgba(0,0,0,0.58) 100%);
  }

  /* ── PAGE SHELL ── */
  .pf-wrap {
    padding:14px 20px 20px;
    font-family:var(--pf-mono);color:var(--pf-text);
    position:relative;z-index:10;
    min-height:100%;
  }
  .pf-wrap::-webkit-scrollbar { width:3px; }
  .pf-wrap::-webkit-scrollbar-thumb { background:var(--pf-border); }

  /* ── PAGE HEADER ── */
  .pf-ph {
    display:flex;align-items:flex-start;justify-content:space-between;
    margin-bottom:10px;
  }
  .pf-title { font-family:var(--pf-bebas);font-size:26px;color:#fff;letter-spacing:3px;line-height:1; }
  .pf-title span { color:var(--pf-g); }
  .pf-meta { font-size:8px;color:var(--pf-muted);letter-spacing:2px;margin-top:5px; }
  .pf-actions { display:flex;gap:8px; }

  /* ── BUTTONS ── */
  .pf-btn {
    padding:8px 18px;font-family:var(--pf-mono);font-size:9px;font-weight:700;
    letter-spacing:3px;text-transform:uppercase;border:none;cursor:pointer;
    clip-path:polygon(6px 0%,100% 0%,calc(100% - 6px) 100%,0% 100%);
    transition:all 0.2s;position:relative;overflow:hidden;
  }
  .pf-btn::before {
    content:'';position:absolute;inset:0;
    background:linear-gradient(90deg,transparent,rgba(255,255,255,0.18),transparent);
    transform:translateX(-100%);transition:transform 0.45s;
  }
  .pf-btn:hover::before { transform:translateX(100%); }
  .pf-btn-p { background:var(--pf-g);color:#000; }
  .pf-btn-p:hover { background:#2dff5c;box-shadow:0 0 24px var(--pf-g25);transform:translateY(-1px); }
  .pf-btn-g { background:transparent;color:var(--pf-muted);border:1px solid var(--pf-borderW); }
  .pf-btn-g:hover { border-color:var(--pf-border);color:#fff;background:var(--pf-g06); }

  /* ── STAT ROW ── */
  .pf-stats { display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px; }
  .pf-sc {
    background:var(--pf-bg2);border:1px solid rgba(0,255,65,0.18);
    padding:12px 14px;position:relative;overflow:hidden;
    transition:border-color 0.2s,transform 0.2s;
  }
  .pf-sc:hover { border-color:rgba(0,255,65,0.32);transform:translateY(-2px); }
  .pf-sc::before {
    content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,transparent,var(--pf-g),transparent);opacity:0.5;
  }
  .pf-sc-lbl { font-size:7px;color:rgba(255,255,255,0.25);letter-spacing:4px;text-transform:uppercase;margin-bottom:6px; }
  .pf-sc-val { font-family:var(--pf-bebas);font-size:26px;line-height:1;letter-spacing:1px; }
  .pf-sc-val.wh { color:#fff; }
  .pf-sc-val.gr { color:var(--pf-g);text-shadow:0 0 18px var(--pf-g25); }
  .pf-sc-val.rd { color:var(--pf-red); }
  .pf-sc-val.dm { color:rgba(255,255,255,0.18); }
  .pf-sc-sub { font-size:7px;color:rgba(255,255,255,0.22);letter-spacing:1px;margin-top:4px;display:flex;align-items:center;gap:5px; }
  .pf-sc-sub .up { color:var(--pf-g); }
  .pf-sc-sub .dn { color:var(--pf-red); }
  .pf-sc-ghost { position:absolute;bottom:4px;right:10px;font-family:var(--pf-bebas);font-size:40px;color:rgba(255,255,255,0.02);line-height:1;pointer-events:none; }

  /* ── CARD ── */
  .pf-card {
    background:var(--pf-bg2);border:1px solid rgba(0,255,65,0.18);
    position:relative;overflow:hidden;
    transition:border-color 0.2s;margin-bottom:10px;
  }
  .pf-card:hover { border-color:rgba(0,255,65,0.28); }
  .pf-card::before {
    content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,transparent,var(--pf-g),transparent);opacity:0.55;
  }
  .pf-ch {
    display:flex;align-items:center;justify-content:space-between;
    padding:9px 14px;border-bottom:1px solid var(--pf-borderW);
  }
  .pf-ch-title {
    font-size:8px;color:rgba(255,255,255,0.28);letter-spacing:4px;
    text-transform:uppercase;display:flex;align-items:center;gap:7px;
  }
  .pf-ch-title::before { content:'\u258C';color:var(--pf-g);font-size:10px; }
  .pf-ch-right { display:flex;align-items:center;gap:8px; }

  /* ── TF PILLS ── */
  .pf-tfs { display:flex;gap:0;border:1px solid var(--pf-borderW);overflow:hidden; }
  .pf-tf {
    padding:5px 12px;font-size:8px;letter-spacing:2px;color:var(--pf-muted);
    border-right:1px solid var(--pf-borderW);transition:all 0.15s;font-family:var(--pf-mono);
    cursor:pointer;
  }
  .pf-tf:last-child { border-right:none; }
  .pf-tf.active { background:var(--pf-g06);color:var(--pf-g); }
  .pf-tf:not(.active):hover { color:#fff;background:var(--pf-faint); }

  /* ── EQUITY CHART ── */
  .pf-chart-body { padding:6px 4px 4px;position:relative; }
  canvas.pf-canvas { display:block;width:100%; }
  .pf-chart-empty {
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    padding:52px 20px;gap:8px;
  }
  .pf-empty-lbl { font-size:8px;color:rgba(255,255,255,0.13);letter-spacing:4px;text-transform:uppercase; }
  .pf-empty-cta { font-size:8px;color:rgba(0,255,65,0.3);letter-spacing:3px;margin-top:3px; }

  /* ── MID ROW ── */
  .pf-mid { display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px; }

  /* ── PERFORMANCE CARD ── */
  .pf-perf-grid { display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--pf-borderW); }
  .pf-perf-item { background:var(--pf-bg2);padding:10px 14px; }
  .pf-perf-lbl { font-size:7px;color:rgba(255,255,255,0.2);letter-spacing:3px;text-transform:uppercase;margin-bottom:5px; }
  .pf-perf-val { font-family:var(--pf-bebas);font-size:20px;color:rgba(255,255,255,0.2);line-height:1;letter-spacing:1px; }
  .pf-perf-val.gr { color:var(--pf-g);text-shadow:0 0 12px var(--pf-g25); }
  .pf-perf-val.rd { color:var(--pf-red); }
  .pf-perf-bar { height:2px;background:rgba(255,255,255,0.05);margin-top:8px;overflow:hidden; }
  .pf-perf-bar-fill { height:100%;background:var(--pf-g);transition:width 0.6s ease; }

  /* ── HOLDINGS TABLE ── */
  .pf-holdings-hdr {
    display:flex;align-items:center;justify-content:space-between;
    padding:12px 18px;border-bottom:1px solid var(--pf-borderW);
  }

  /* ── TOGGLE SWITCH ── */
  .pf-toggle-wrap {
    display:flex;align-items:center;gap:10px;
    font-size:8px;color:var(--pf-muted);letter-spacing:2px;
    text-transform:uppercase;cursor:pointer;
  }
  .pf-toggle {
    width:36px;height:18px;border-radius:0;
    background:rgba(255,255,255,0.06);border:1px solid var(--pf-borderW);
    position:relative;transition:all 0.2s;flex-shrink:0;
    clip-path:polygon(3px 0%,100% 0%,calc(100% - 3px) 100%,0% 100%);
  }
  .pf-toggle.on {
    background:var(--pf-g12);border-color:var(--pf-g50);
    box-shadow:0 0 10px rgba(0,255,65,0.15);
  }
  .pf-toggle-knob {
    position:absolute;top:2px;left:2px;
    width:12px;height:12px;
    background:rgba(255,255,255,0.2);
    transition:all 0.2s;
    clip-path:polygon(2px 0%,100% 0%,calc(100% - 2px) 100%,0% 100%);
  }
  .pf-toggle.on .pf-toggle-knob {
    left:20px;background:var(--pf-g);
    box-shadow:0 0 6px var(--pf-g);
  }
  .pf-toggle-label { transition:color 0.2s; }
  .pf-toggle.on + .pf-toggle-label { color:var(--pf-g); }

  /* ── TABLE ── */
  .pf-tbl { width:100%;border-collapse:collapse; }
  .pf-tbl th {
    font-size:7px;color:rgba(255,255,255,0.18);letter-spacing:3px;
    text-transform:uppercase;padding:7px 14px;
    border-bottom:1px solid var(--pf-borderW);text-align:left;font-weight:400;
  }
  .pf-tbl th:not(:first-child) { text-align:right; }
  .pf-tbl td { padding:8px 14px;font-size:10px;border-bottom:1px solid var(--pf-faint);transition:background 0.15s; }
  .pf-tbl td:not(:first-child) { text-align:right; }
  .pf-tbl tr:last-child td { border-bottom:none; }
  .pf-tbl tr:hover td { background:var(--pf-g06); }

  /* asset cell */
  .pf-asset-cell { display:flex;align-items:center;gap:10px; }
  .pf-asset-icon {
    width:24px;height:24px;border:1px solid var(--pf-border);
    background:var(--pf-g06);display:flex;align-items:center;justify-content:center;
    font-size:8px;font-weight:700;color:var(--pf-g);flex-shrink:0;
    clip-path:polygon(4px 0%,100% 0%,calc(100% - 4px) 100%,0% 100%);
  }
  .pf-asset-name { font-family:var(--pf-bebas);font-size:15px;color:#fff;letter-spacing:1px; }
  .pf-asset-full { font-size:8px;color:rgba(255,255,255,0.3);letter-spacing:1px;margin-top:1px; }

  .pf-val-primary { font-family:var(--pf-bebas);font-size:16px;color:rgba(255,255,255,0.7);letter-spacing:1px; }
  .pf-val-primary.gr { color:var(--pf-g); }
  .pf-val-secondary { font-size:8px;color:rgba(255,255,255,0.25);letter-spacing:1px;margin-top:2px; }
  .pf-val-zero { color:rgba(255,255,255,0.15); }

  /* USD value column */
  .pf-usd-val { font-family:var(--pf-bebas);font-size:18px;color:#fff;letter-spacing:1px; }
  .pf-usd-val.zero { color:rgba(255,255,255,0.15); }

  /* allocation bar */
  .pf-alloc { display:flex;align-items:center;gap:8px; }
  .pf-alloc-bar { width:60px;height:3px;background:rgba(255,255,255,0.05);overflow:hidden;flex-shrink:0; }
  .pf-alloc-fill { height:100%;background:var(--pf-g);transition:width 0.5s ease; }
  .pf-alloc-pct { font-size:8px;color:rgba(255,255,255,0.3);letter-spacing:1px;width:34px;text-align:right; }

  /* row enter animation */
  .pf-row-enter {
    animation:pfRowIn 0.3s ease both;
  }
  @keyframes pfRowIn { from{opacity:0;transform:translateX(-8px)} to{opacity:1;transform:translateX(0)} }

  /* ── TRADE HISTORY ── */
  .pf-hist-sym { font-family:var(--pf-bebas);font-size:16px;color:#fff; }
  .pf-side-b { font-size:7px;color:var(--pf-g);letter-spacing:2px;border:1px solid rgba(0,255,65,0.3);padding:1px 5px; }
  .pf-side-s { font-size:7px;color:var(--pf-red);letter-spacing:2px;border:1px solid rgba(255,59,59,0.3);padding:1px 5px; }
  .pf-pnl-pos { color:var(--pf-g); }
  .pf-pnl-neg { color:var(--pf-red); }
  .pf-dim { color:rgba(255,255,255,0.38); }
  .pf-xs  { font-size:8px;color:rgba(255,255,255,0.2);letter-spacing:1px; }

  /* ── EMPTY STATE ── */
  .pf-empty {
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    padding:40px;gap:7px;
  }
  .pf-empty-icon { font-size:22px;opacity:0.12; }

  /* ── ANIMATIONS ── */
  .pf-fu { animation:pfFadeUp 0.35s ease both; }
  @keyframes pfFadeUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
  .pf-d1{animation-delay:0.05s} .pf-d2{animation-delay:0.1s}
  .pf-d3{animation-delay:0.16s} .pf-d4{animation-delay:0.22s}
  .pf-d5{animation-delay:0.28s}
`;

/* ── ICON MAP ── */
const ASSET_ICONS: Record<string, string> = {
  USD: "$",
  BTC: "\u20BF",
  ETH: "\u039E",
  SOL: "\u25CE",
};

const TFS = ["1D", "1W", "1M", "3M", "ALL"] as const;
type TimeRange = (typeof TFS)[number];

function rangeToFrom(range: TimeRange): number | undefined {
  const now = new Date();
  switch (range) {
    case "1D": return subDays(now, 1).getTime();
    case "1W": return subDays(now, 7).getTime();
    case "1M": return subMonths(now, 1).getTime();
    case "3M": return subMonths(now, 3).getTime();
    case "ALL": return undefined;
  }
}

function fmtUsd(val: Decimal): string {
  const abs = val.abs();
  const parts = abs.toFixed(2).split(".");
  const intWithCommas = (parts[0] ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const formatted = `$${intWithCommas}.${parts[1]}`;
  return val.isNegative() ? `-${formatted}` : formatted;
}

function fmtDec(val: Decimal, decimals: number): string {
  const fixed = val.toFixed(decimals);
  const [intPart, fracPart] = fixed.split(".");
  const intWithCommas = (intPart ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fracPart !== undefined ? `${intWithCommas}.${fracPart}` : intWithCommas;
}

function fmtPct(val: Decimal): string {
  const sign = val.isPositive() ? "+" : "";
  return `${sign}${val.toFixed(2)}%`;
}

/* ── Closed trade type from journal API ── */
interface ClosedTrade {
  id: string;
  pair_symbol: string;
  direction: "LONG" | "SHORT";
  entry_avg_price: string;
  exit_avg_price: string;
  entry_qty: string;
  gross_pnl: string;
  total_fees: string;
  net_pnl: string;
  return_pct: string;
  holding_seconds: number;
  exit_at: string;
}

/* ── Journal summary type ── */
interface JournalSummaryData {
  total_trades: number;
  win_rate: string;
  avg_return_pct: string;
  best_trade_pnl: string;
  worst_trade_pnl: string;
  avg_holding_seconds: number;
  total_pnl: string;
  total_fees: string;
}

/* ── EQUITY CHART ── */
function EquityChart({ snapshots }: { snapshots: PortfolioSnapshot[] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const W = canvas.offsetWidth;
    const H = 120;
    if (W === 0) return;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // grid
    ctx.strokeStyle = "rgba(0,255,65,0.04)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo(0, (H / 4) * i); ctx.lineTo(W, (H / 4) * i); ctx.stroke();
    }
    for (let i = 1; i < 7; i++) {
      ctx.beginPath(); ctx.moveTo((W / 7) * i, 0); ctx.lineTo((W / 7) * i, H); ctx.stroke();
    }

    if (snapshots.length < 2) {
      // Empty state — no data
      const baseY = H * 0.6;
      ctx.setLineDash([5, 7]);
      ctx.strokeStyle = "rgba(0,255,65,0.22)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, baseY); ctx.lineTo(W, baseY); ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "rgba(0,255,65,0.28)";
      ctx.font = "8px Space Mono, monospace";
      ctx.fillText("$100,000 \u2014 starting capital", 14, baseY - 7);

      const grad = ctx.createLinearGradient(W * 0.5, 0, W, 0);
      grad.addColorStop(0, "rgba(0,255,65,0)");
      grad.addColorStop(1, "rgba(0,255,65,0.04)");
      ctx.fillStyle = grad;
      ctx.fillRect(W * 0.5, 0, W * 0.5, H);

      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.font = "700 10px Space Mono, monospace";
      ctx.textAlign = "center";
      ctx.fillText("\u25B8 TRADE TO START TRACKING EQUITY", W / 2, H / 2 + 4);
      ctx.textAlign = "left";
      return;
    }

    // Plot real equity data
    const values = snapshots.map((s) => parseFloat(s.equity_quote));
    const minV = Math.min(...values);
    const maxV = Math.max(...values);
    const range = maxV - minV || 1;
    const padH = 16;
    const padV = 12;

    // Equity line
    ctx.beginPath();
    for (let i = 0; i < values.length; i++) {
      const x = padH + ((W - padH * 2) / (values.length - 1)) * i;
      const y = padV + (1 - (values[i]! - minV) / range) * (H - padV * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#00ff41";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Fill under
    const lastX = padH + (W - padH * 2);
    ctx.lineTo(lastX, H);
    ctx.lineTo(padH, H);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "rgba(0,255,65,0.12)");
    grad.addColorStop(1, "rgba(0,255,65,0)");
    ctx.fillStyle = grad;
    ctx.fill();

    // Labels
    ctx.fillStyle = "rgba(0,255,65,0.4)";
    ctx.font = "8px Space Mono, monospace";
    ctx.fillText(`$${maxV.toLocaleString(undefined, { minimumFractionDigits: 0 })}`, 6, padV + 4);
    ctx.fillText(`$${minV.toLocaleString(undefined, { minimumFractionDigits: 0 })}`, 6, H - padV + 2);
  }, [snapshots]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas.parentElement ?? canvas);
    draw();
    return () => ro.disconnect();
  }, [draw]);

  return <canvas ref={ref} className="pf-canvas" height={120} />;
}

/* ── HOLDINGS ROW TYPE ── */
interface HoldingRow {
  sym: string;
  name: string;
  bal: string;
  reserved: string;
  avail: string;
  usd: string;
  alloc: number;
  icon: string;
  zero: boolean;
}

/* ── HOLDINGS TABLE ── */
function HoldingsTable({ rows }: { rows: HoldingRow[] }) {
  return (
    <table className="pf-tbl">
      <thead>
        <tr>
          <th>Asset</th>
          <th>Balance</th>
          <th>Reserved</th>
          <th>Available</th>
          <th>Allocation</th>
          <th>USD Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((h, i) => (
          <tr key={h.sym} className="pf-row-enter" style={{ animationDelay: `${i * 0.04}s` }}>
            <td>
              <div className="pf-asset-cell">
                <div className="pf-asset-icon">{h.icon}</div>
                <div>
                  <div className="pf-asset-name">{h.sym}</div>
                  <div className="pf-asset-full">{h.name}</div>
                </div>
              </div>
            </td>
            <td>
              <div className={`pf-val-primary${h.zero ? " pf-val-zero" : ""}`}>{h.bal}</div>
            </td>
            <td>
              <div className="pf-val-primary pf-val-zero">{h.reserved}</div>
            </td>
            <td>
              <div className={`pf-val-primary${h.zero ? " pf-val-zero" : " gr"}`}>{h.avail}</div>
            </td>
            <td>
              <div className="pf-alloc">
                <div className="pf-alloc-bar">
                  <div className="pf-alloc-fill" style={{ width: `${h.alloc}%` }} />
                </div>
                <span className="pf-alloc-pct">{h.alloc}%</span>
              </div>
            </td>
            <td>
              <div className={`pf-usd-val${h.zero ? " zero" : ""}`}>{h.usd}</div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ── TOGGLE ── */
function Toggle({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <div className="pf-toggle-wrap" onClick={onToggle}>
      <div className={`pf-toggle${on ? " on" : ""}`}>
        <div className="pf-toggle-knob" />
      </div>
      <span className="pf-toggle-label" style={{ color: on ? "var(--pf-g)" : "var(--pf-muted)" }}>
        {label}
      </span>
    </div>
  );
}

/* ── PERF STAT TYPE ── */
interface PerfStat {
  label: string;
  val: string;
  pct: number;
  cls: string;
}

/* ─────────────────────────────────────────
   MAIN PORTFOLIO COMPONENT
───────────────────────────────────────── */
export default function PortfolioPage() {
  const navigate = useNavigate();
  const wallets = useAppStore((s) => s.wallets);
  const assets = useAppStore((s) => s.assets);
  const pairs = useAppStore((s) => s.pairs);
  const activeCompetitionId = useTradingStore((s) => s.activeCompetitionId);

  const [tf, setTf] = useState<TimeRange>("1M");
  const [hideZero, setHideZero] = useState(false);
  const [clock, setClock] = useState("");

  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [snapshots, setSnapshots] = useState<PortfolioSnapshot[]>([]);
  const [performance, setPerformance] = useState<PerformanceSummary | null>(null);
  const [trades, setTrades] = useState<ClosedTrade[]>([]);
  const [journalSummary, setJournalSummary] = useState<JournalSummaryData | null>(null);

  // Inject CSS
  useEffect(() => {
    const id = "tradr-portfolio-css";
    if (!document.getElementById(id)) {
      const s = document.createElement("style");
      s.id = id;
      s.textContent = PORTFOLIO_CSS;
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

  // Load portfolio summary, performance, trades
  useEffect(() => {
    let cancelled = false;
    const compId = activeCompetitionId ?? undefined;

    Promise.allSettled([
      getSummary(activeCompetitionId),
      getPerformance({ competitionId: compId }),
      getJournal({ limit: 20 }),
      getJournalSummary(),
    ]).then(([sumRes, perfRes, tradesRes, jSumRes]) => {
      if (cancelled) return;
      if (sumRes.status === "fulfilled") setSummary(sumRes.value.data.summary);
      if (perfRes.status === "fulfilled") setPerformance(perfRes.value.data.performance);
      if (tradesRes.status === "fulfilled") {
        const data = tradesRes.value.data as { trades: ClosedTrade[] };
        setTrades(data.trades ?? []);
      }
      if (jSumRes.status === "fulfilled") {
        const data = jSumRes.value.data as { summary: JournalSummaryData };
        setJournalSummary(data.summary ?? null);
      }
    });

    return () => { cancelled = true; };
  }, [activeCompetitionId]);

  // Load equity curve when time range changes
  const loadEquity = useCallback(
    async (range: TimeRange) => {
      try {
        const from = rangeToFrom(range);
        const compId = activeCompetitionId ?? undefined;
        const res = await getEquityCurve({ from, competitionId: compId });
        setSnapshots(res.data.snapshots ?? []);
      } catch {
        // Non-fatal
      }
    },
    [activeCompetitionId],
  );

  useEffect(() => {
    loadEquity(tf);
  }, [tf, loadEquity]);

  // ── Build holdings rows from real wallet data ──
  const assetMap = Object.fromEntries(assets.map((a) => [a.id, a]));
  const usdAsset = assets.find((a) => a.symbol === "USD");
  const priceByAssetId: Record<string, Decimal> = {};
  if (usdAsset) {
    for (const pair of pairs) {
      if (pair.quote_asset_id === usdAsset.id && pair.last_price) {
        try {
          priceByAssetId[pair.base_asset_id] = new Decimal(pair.last_price);
        } catch {
          // skip invalid price
        }
      }
    }
  }

  const enrichedWallets = wallets
    .map((wallet) => {
      const asset = assetMap[wallet.asset_id];
      if (!asset || !asset.is_active) return null;
      try {
        const balance = new Decimal(wallet.balance ?? "0");
        const reserved = new Decimal(wallet.reserved ?? "0");
        const available = balance.minus(reserved);
        let usdValue = new Decimal(0);
        if (asset.symbol === "USD") {
          usdValue = balance;
        } else if (priceByAssetId[wallet.asset_id]) {
          usdValue = balance.times(priceByAssetId[wallet.asset_id]!);
        }
        return { asset, balance, reserved, available, usdValue };
      } catch {
        return null;
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.usdValue.minus(a.usdValue).toNumber());

  const totalPortfolioValue = enrichedWallets.reduce(
    (acc, r) => acc.plus(r.usdValue),
    new Decimal(0),
  );

  const holdingRows: HoldingRow[] = enrichedWallets.map((r) => {
    const isZero = r.usdValue.isZero();
    const decimals = r.asset.symbol === "USD" ? 2 : 8;
    const alloc = totalPortfolioValue.isZero() ? 0 : r.usdValue.div(totalPortfolioValue).times(100).toNumber();
    return {
      sym: r.asset.symbol,
      name: r.asset.name,
      bal: fmtDec(r.balance, decimals),
      reserved: fmtDec(r.reserved, decimals),
      avail: fmtDec(r.available, decimals),
      usd: fmtUsd(r.usdValue),
      alloc: Math.round(alloc),
      icon: ASSET_ICONS[r.asset.symbol] ?? r.asset.symbol[0] ?? "?",
      zero: isZero,
    };
  });

  const filteredRows = hideZero ? holdingRows.filter((h) => !h.zero) : holdingRows;

  // ── Stat card values ──
  const safeDecimal = (v: string | undefined | null) => new Decimal(v ?? "0");
  const equityVal = summary ? fmtUsd(safeDecimal(summary.equity_quote)) : fmtUsd(totalPortfolioValue);
  const realizedPnl = summary ? safeDecimal(summary.realized_pnl_quote) : new Decimal(0);
  const unrealizedPnl = summary ? safeDecimal(summary.unrealized_pnl_quote) : new Decimal(0);
  const startingCapital = new Decimal(100000);
  const currentEquity = summary ? safeDecimal(summary.equity_quote) : totalPortfolioValue;
  const totalReturnPct = currentEquity.minus(startingCapital).div(startingCapital).times(100);

  const hasRealizedData = !realizedPnl.isZero();
  const hasUnrealizedData = !unrealizedPnl.isZero();
  const hasTotalReturn = !totalReturnPct.isZero();

  // ── Performance stats ──
  const perfStats: PerfStat[] = (() => {
    if (!journalSummary || journalSummary.total_trades === 0) {
      return [
        { label: "Total Return", val: "\u2014\u2014", pct: 0, cls: "dm" },
        { label: "Win Rate", val: "\u2014\u2014", pct: 0, cls: "dm" },
        { label: "Best Trade", val: "\u2014\u2014", pct: 0, cls: "dm" },
        { label: "Worst Trade", val: "\u2014\u2014", pct: 0, cls: "dm" },
        { label: "Total Trades", val: "0", pct: 0, cls: "dm" },
        { label: "Avg Hold Time", val: "\u2014\u2014", pct: 0, cls: "dm" },
        { label: "Sharpe Ratio", val: "\u2014\u2014", pct: 0, cls: "dm" },
        { label: "Max Drawdown", val: "\u2014\u2014", pct: 0, cls: "dm" },
      ];
    }

    const js = journalSummary;
    const winRate = parseFloat(js.win_rate ?? "0");
    const bestPnl = safeDecimal(js.best_trade_pnl);
    const worstPnl = safeDecimal(js.worst_trade_pnl);
    const maxDd = performance ? safeDecimal(performance.max_drawdown_pct) : new Decimal(0);

    const holdMins = Math.round(js.avg_holding_seconds / 60);
    const holdStr = holdMins >= 60 ? `${Math.round(holdMins / 60)}h ${holdMins % 60}m` : `${holdMins}m`;

    return [
      { label: "Total Return", val: fmtPct(totalReturnPct), pct: Math.min(Math.abs(totalReturnPct.toNumber()), 100), cls: totalReturnPct.isPositive() ? "gr" : totalReturnPct.isNegative() ? "rd" : "dm" },
      { label: "Win Rate", val: `${winRate.toFixed(1)}%`, pct: winRate, cls: winRate >= 50 ? "gr" : "rd" },
      { label: "Best Trade", val: fmtUsd(bestPnl), pct: 0, cls: bestPnl.isPositive() ? "gr" : "dm" },
      { label: "Worst Trade", val: fmtUsd(worstPnl), pct: 0, cls: worstPnl.isNegative() ? "rd" : "dm" },
      { label: "Total Trades", val: String(js.total_trades), pct: 0, cls: "dm" },
      { label: "Avg Hold Time", val: holdStr, pct: 0, cls: "dm" },
      { label: "Sharpe Ratio", val: "\u2014\u2014", pct: 0, cls: "dm" },
      { label: "Max Drawdown", val: maxDd.isZero() ? "\u2014\u2014" : fmtPct(maxDd.negated()), pct: Math.min(maxDd.abs().toNumber(), 100), cls: maxDd.isZero() ? "dm" : "rd" },
    ];
  })();

  return (
    <div className="pf-wrap">
      <div className="pf-grid" />
      <div className="pf-scan" />
      <div className="pf-vig" />

      {/* PAGE HEADER */}
      <div className="pf-ph pf-fu">
        <div>
          <div className="pf-title">PORT<span>FOLIO</span></div>
          <div className="pf-meta">{clock}</div>
        </div>
        <div className="pf-actions">
          <button className="pf-btn pf-btn-g">{"\u2193"} EXPORT</button>
          <button className="pf-btn pf-btn-p" onClick={() => navigate("/trade")}>{"\u25B9"} TRADE NOW</button>
        </div>
      </div>

      {/* STAT CARDS */}
      <div className="pf-stats pf-fu pf-d1">
        <div className="pf-sc">
          <div className="pf-sc-lbl">Total Value</div>
          <div className="pf-sc-val wh">{equityVal}</div>
          <div className="pf-sc-sub">
            {hasTotalReturn
              ? <><span className={totalReturnPct.isPositive() ? "up" : "dn"}>{fmtPct(totalReturnPct)}</span> from $100K</>
              : "Starting capital deployed"}
          </div>
          <div className="pf-sc-ghost">$</div>
        </div>
        <div className="pf-sc">
          <div className="pf-sc-lbl">Total Return</div>
          <div className={`pf-sc-val ${hasTotalReturn ? (totalReturnPct.isPositive() ? "gr" : "rd") : "dm"}`}>
            {hasTotalReturn ? fmtPct(totalReturnPct) : "\u2014\u2014"}
          </div>
          <div className="pf-sc-sub">{hasTotalReturn ? `Equity: ${equityVal}` : "No closed trades yet"}</div>
          <div className="pf-sc-ghost">%</div>
        </div>
        <div className="pf-sc">
          <div className="pf-sc-lbl">Realized PnL</div>
          <div className={`pf-sc-val ${hasRealizedData ? (realizedPnl.isPositive() ? "gr" : "rd") : "dm"}`}>
            {hasRealizedData ? fmtUsd(realizedPnl) : "\u2014\u2014"}
          </div>
          <div className="pf-sc-sub">
            Closed trades: <span style={{ color: "rgba(255,255,255,0.3)" }}>{trades.length}</span>
          </div>
          <div className="pf-sc-ghost">{"\u03A3"}</div>
        </div>
        <div className="pf-sc">
          <div className="pf-sc-lbl">Unrealized PnL</div>
          <div className={`pf-sc-val ${hasUnrealizedData ? (unrealizedPnl.isPositive() ? "gr" : "rd") : "dm"}`}>
            {hasUnrealizedData ? fmtUsd(unrealizedPnl) : "\u2014\u2014"}
          </div>
          <div className="pf-sc-sub">
            Open positions: <span style={{ color: "rgba(255,255,255,0.3)" }}>
              {summary && !new Decimal(summary.holdings_quote).isZero() ? "\u25CF" : "0"}
            </span>
          </div>
          <div className="pf-sc-ghost">~</div>
        </div>
      </div>

      {/* MID ROW — equity + performance */}
      <div className="pf-mid pf-fu pf-d2">
        {/* EQUITY CURVE */}
        <div className="pf-card">
          <div className="pf-ch">
            <span className="pf-ch-title">Equity Curve</span>
            <div className="pf-ch-right">
              <div className="pf-tfs">
                {TFS.map((t) => (
                  <div key={t} className={`pf-tf${tf === t ? " active" : ""}`} onClick={() => setTf(t)}>{t}</div>
                ))}
              </div>
            </div>
          </div>
          <div className="pf-chart-body">
            <EquityChart snapshots={snapshots} />
          </div>
        </div>

        {/* PERFORMANCE */}
        <div className="pf-card">
          <div className="pf-ch">
            <span className="pf-ch-title">Performance Stats</span>
            <span style={{ fontSize: 8, color: "rgba(0,255,65,0.3)", letterSpacing: 2 }}>ALL TIME</span>
          </div>
          <div className="pf-perf-grid">
            {perfStats.map((p, i) => (
              <div key={i} className="pf-perf-item">
                <div className="pf-perf-lbl">{p.label}</div>
                <div className={`pf-perf-val${p.cls === "gr" ? " gr" : p.cls === "rd" ? " rd" : ""}`}>{p.val}</div>
                <div className="pf-perf-bar">
                  <div className="pf-perf-bar-fill" style={{ width: `${p.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* HOLDINGS */}
      <div className="pf-card pf-fu pf-d3">
        <div className="pf-ch">
          <span className="pf-ch-title">Holdings</span>
          <div className="pf-ch-right">
            <Toggle
              on={hideZero}
              onToggle={() => setHideZero((h) => !h)}
              label="HIDE ZERO BALANCES"
            />
          </div>
        </div>
        {filteredRows.length === 0 ? (
          <div className="pf-empty">
            <div className="pf-empty-icon">{"\u25C8"}</div>
            <div className="pf-empty-lbl">No holdings to display</div>
          </div>
        ) : (
          <HoldingsTable rows={filteredRows} />
        )}
      </div>

      {/* TRADE HISTORY — only shown when trades exist */}
      {trades.length > 0 && (
        <div className="pf-card pf-fu pf-d4">
          <div className="pf-ch">
            <span className="pf-ch-title">Trade History</span>
            <div className="pf-ch-right">
              <span style={{ fontSize: 8, color: "rgba(255,255,255,0.15)", letterSpacing: 2 }}>
                {trades.length} TRADE{trades.length !== 1 ? "S" : ""}
              </span>
            </div>
          </div>
          <table className="pf-tbl">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Side</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>PnL</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t, i) => {
                const pnl = new Decimal(t.net_pnl);
                const isPos = pnl.isPositive();
                return (
                  <tr key={t.id} className="pf-row-enter" style={{ animationDelay: `${i * 0.04}s` }}>
                    <td>
                      <span className="pf-hist-sym">{t.pair_symbol.replace("/USD", "")}</span>
                    </td>
                    <td>
                      <span className={t.direction === "LONG" ? "pf-side-b" : "pf-side-s"}>
                        {t.direction === "LONG" ? "BUY" : "SELL"}
                      </span>
                    </td>
                    <td>
                      <span className="pf-dim">${parseFloat(t.entry_avg_price).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                    </td>
                    <td>
                      <span className="pf-dim">${parseFloat(t.exit_avg_price).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                    </td>
                    <td>
                      <span className={isPos ? "pf-pnl-pos" : "pf-pnl-neg"}>
                        {isPos ? "+" : ""}{fmtUsd(pnl)}
                      </span>
                    </td>
                    <td>
                      <span className="pf-xs">{format(new Date(t.exit_at), "MMM d, HH:mm")}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
