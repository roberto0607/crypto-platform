import { useState, useEffect, useCallback } from "react";
import { useAppStore } from "@/stores/appStore";
import { getJournal, getJournalSummary, exportJournalCsv } from "@/api/endpoints/journal";
import { format } from "date-fns";

/* ─────────────────────────────────────────
   JOURNAL PAGE CSS — Circuit Noir
───────────────────────────────────────── */
const JOURNAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap');

  :root {
    --jn-g:      #00ff41;
    --jn-g50:    rgba(0,255,65,0.5);
    --jn-g25:    rgba(0,255,65,0.25);
    --jn-g12:    rgba(0,255,65,0.12);
    --jn-g06:    rgba(0,255,65,0.06);
    --jn-red:    #ff3b3b;
    --jn-red12:  rgba(255,59,59,0.12);
    --jn-yellow: #ffd700;
    --jn-bg:     #040404;
    --jn-bg2:    #080808;
    --jn-border: rgba(0,255,65,0.16);
    --jn-borderW:rgba(255,255,255,0.06);
    --jn-muted:  rgba(255,255,255,0.3);
    --jn-faint:  rgba(255,255,255,0.05);
    --jn-bebas:  'Bebas Neue', sans-serif;
    --jn-mono:   'Space Mono', monospace;
  }

  .jn-grid { position:fixed;inset:0;pointer-events:none;z-index:0;
    background-image:linear-gradient(rgba(0,255,65,0.02) 1px,transparent 1px),
    linear-gradient(90deg,rgba(0,255,65,0.02) 1px,transparent 1px);
    background-size:48px 48px; }
  .jn-scan { position:fixed;inset:0;pointer-events:none;z-index:1;
    background:repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,0,0,0.05) 3px,rgba(0,0,0,0.05) 4px); }
  .jn-vig  { position:fixed;inset:0;pointer-events:none;z-index:1;
    background:radial-gradient(ellipse 110% 110% at 50% 50%,transparent 30%,rgba(0,0,0,0.58) 100%); }

  .jn-wrap {
    padding:22px 24px 44px;font-family:var(--jn-mono);
    color:rgba(255,255,255,0.88);position:relative;z-index:10;
    min-height:100%;
  }
  .jn-wrap::-webkit-scrollbar{width:3px}
  .jn-wrap::-webkit-scrollbar-thumb{background:var(--jn-border)}

  /* PAGE HEADER */
  .jn-ph { display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px; }
  .jn-title { font-family:var(--jn-bebas);font-size:30px;color:#fff;letter-spacing:3px;line-height:1; }
  .jn-title span { color:var(--jn-g); }
  .jn-meta { font-size:8px;color:var(--jn-muted);letter-spacing:2px;margin-top:5px; }
  .jn-actions { display:flex;gap:8px;align-items:flex-start; }

  /* BUTTONS */
  .jn-btn {
    padding:8px 18px;font-family:var(--jn-mono);font-size:9px;font-weight:700;
    letter-spacing:3px;text-transform:uppercase;border:none;cursor:pointer;
    clip-path:polygon(6px 0%,100% 0%,calc(100% - 6px) 100%,0% 100%);
    transition:all 0.2s;position:relative;overflow:hidden;
  }
  .jn-btn::before { content:'';position:absolute;inset:0;
    background:linear-gradient(90deg,transparent,rgba(255,255,255,0.18),transparent);
    transform:translateX(-100%);transition:transform 0.45s; }
  .jn-btn:hover::before { transform:translateX(100%); }
  .jn-btn-p { background:var(--jn-g);color:#000; }
  .jn-btn-p:hover { background:#2dff5c;box-shadow:0 0 24px var(--jn-g25);transform:translateY(-1px); }
  .jn-btn-g { background:transparent;color:var(--jn-muted);border:1px solid var(--jn-borderW); }
  .jn-btn-g:hover { border-color:var(--jn-border);color:#fff;background:var(--jn-g06); }

  /* STAT CARDS */
  .jn-stats { display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:14px; }
  .jn-sc {
    background:var(--jn-bg2);border:1px solid rgba(0,255,65,0.18);
    padding:16px 18px;position:relative;overflow:hidden;
    transition:border-color 0.2s,transform 0.2s;
  }
  .jn-sc:hover { border-color:rgba(0,255,65,0.32);transform:translateY(-2px); }
  .jn-sc::before { content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,transparent,var(--jn-g),transparent);opacity:0.5; }
  .jn-sc-lbl { font-size:7px;color:rgba(255,255,255,0.22);letter-spacing:4px;text-transform:uppercase;margin-bottom:9px; }
  .jn-sc-val { font-family:var(--jn-bebas);font-size:28px;line-height:1;letter-spacing:1px; }
  .jn-sc-val.wh { color:#fff; }
  .jn-sc-val.gr { color:var(--jn-g);text-shadow:0 0 16px var(--jn-g25); }
  .jn-sc-val.rd { color:var(--jn-red); }
  .jn-sc-val.dm { color:rgba(255,255,255,0.15); }
  .jn-sc-sub { font-size:7px;color:rgba(255,255,255,0.18);letter-spacing:1px;margin-top:6px; }
  .jn-sc-ghost { position:absolute;bottom:6px;right:10px;font-family:var(--jn-bebas);
    font-size:46px;color:rgba(255,255,255,0.02);line-height:1;pointer-events:none; }

  /* FILTER BAR */
  .jn-filterbar {
    display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap;
  }

  /* SELECT DROPDOWNS */
  .jn-sel-wrap { position:relative;display:flex;align-items:center; }
  .jn-sel-wrap::after {
    content:'\u25BE';position:absolute;right:11px;top:50%;transform:translateY(-50%);
    font-size:9px;color:var(--jn-muted);pointer-events:none;
  }
  .jn-sel {
    appearance:none;-webkit-appearance:none;
    background:var(--jn-bg2);border:1px solid var(--jn-borderW);
    font-family:var(--jn-mono);font-size:9px;letter-spacing:2px;
    color:rgba(255,255,255,0.65);padding:7px 28px 7px 12px;
    text-transform:uppercase;transition:all 0.15s;outline:none;
    clip-path:polygon(5px 0%,100% 0%,calc(100% - 5px) 100%,0% 100%);
  }
  .jn-sel:focus { border-color:var(--jn-g50);color:#fff;background:rgba(0,255,65,0.04); }
  .jn-sel:hover { border-color:var(--jn-border);color:#fff; }
  .jn-sel option { background:#0c0c0c;color:#fff; }

  .jn-sep { width:1px;height:20px;background:var(--jn-borderW); }
  .jn-sp  { flex:1; }

  /* search */
  .jn-search-wrap {
    display:flex;align-items:center;border:1px solid var(--jn-borderW);
    background:var(--jn-bg2);transition:border-color 0.2s;
    clip-path:polygon(5px 0%,100% 0%,calc(100% - 5px) 100%,0% 100%);
  }
  .jn-search-wrap:focus-within { border-color:var(--jn-g50); }
  .jn-search-icon { font-size:10px;color:var(--jn-muted);padding:0 10px;flex-shrink:0; }
  .jn-search-wrap input {
    background:transparent;border:none;outline:none;
    font-family:var(--jn-mono);font-size:9px;color:#fff;letter-spacing:1px;
    padding:7px 12px 7px 0;width:180px;
  }
  .jn-search-wrap input::placeholder { color:rgba(255,255,255,0.15);letter-spacing:2px; }

  /* JOURNAL TABLE CARD */
  .jn-card {
    background:var(--jn-bg2);border:1px solid rgba(0,255,65,0.18);
    position:relative;overflow:hidden;margin-bottom:14px;
  }
  .jn-card::before { content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,transparent,var(--jn-g),transparent);opacity:0.55; }
  .jn-card-hdr {
    display:flex;align-items:center;justify-content:space-between;
    padding:12px 18px;border-bottom:1px solid var(--jn-borderW);
  }
  .jn-card-title {
    font-size:8px;color:rgba(255,255,255,0.28);letter-spacing:4px;text-transform:uppercase;
    display:flex;align-items:center;gap:7px;
  }
  .jn-card-title::before { content:'\u258C';color:var(--jn-g);font-size:10px; }
  .jn-card-meta { font-size:8px;color:rgba(255,255,255,0.15);letter-spacing:2px; }

  /* TABLE */
  .jn-tbl { width:100%;border-collapse:collapse; }
  .jn-tbl th {
    font-size:7px;color:rgba(255,255,255,0.18);letter-spacing:3px;text-transform:uppercase;
    padding:10px 18px;border-bottom:1px solid var(--jn-borderW);text-align:left;font-weight:400;
  }
  .jn-tbl th.r { text-align:right; }
  .jn-tbl th.sort { color:rgba(0,255,65,0.6);letter-spacing:3px; }
  .jn-tbl th.sort::after { content:' \u25BE'; }
  .jn-tbl td {
    padding:13px 18px;font-size:10px;
    border-bottom:1px solid var(--jn-faint);transition:background 0.12s;
    vertical-align:middle;
  }
  .jn-tbl td.r { text-align:right; }
  .jn-tbl tr:last-child td { border-bottom:none; }
  .jn-tbl tr:hover td { background:var(--jn-g06); }
  .jn-tbl tr.win:hover td { background:rgba(0,255,65,0.07); }
  .jn-tbl tr.loss:hover td { background:rgba(255,59,59,0.05); }

  /* asset cell */
  .jn-asset { display:flex;align-items:center;gap:10px; }
  .jn-asset-icon {
    width:26px;height:26px;border:1px solid var(--jn-border);
    background:var(--jn-g06);display:flex;align-items:center;justify-content:center;
    font-size:9px;font-weight:700;color:var(--jn-g);flex-shrink:0;
    clip-path:polygon(3px 0%,100% 0%,calc(100% - 3px) 100%,0% 100%);
  }
  .jn-sym { font-family:var(--jn-bebas);font-size:17px;color:#fff;letter-spacing:1px; }
  .jn-pair { font-size:8px;color:rgba(255,255,255,0.25);letter-spacing:1px;margin-top:1px; }

  /* side badge */
  .jn-side-b { font-size:7px;color:var(--jn-g);letter-spacing:2px;
    border:1px solid rgba(0,255,65,0.3);padding:2px 6px;
    clip-path:polygon(3px 0%,100% 0%,calc(100% - 3px) 100%,0% 100%); }
  .jn-side-s { font-size:7px;color:var(--jn-red);letter-spacing:2px;
    border:1px solid rgba(255,59,59,0.3);padding:2px 6px;
    clip-path:polygon(3px 0%,100% 0%,calc(100% - 3px) 100%,0% 100%); }

  /* price */
  .jn-price { font-family:var(--jn-bebas);font-size:15px;color:rgba(255,255,255,0.6);letter-spacing:1px; }
  .jn-price-sub { font-size:8px;color:rgba(255,255,255,0.2);letter-spacing:1px;margin-top:1px; }

  /* pnl */
  .jn-pnl-pos { font-family:var(--jn-bebas);font-size:17px;color:var(--jn-g);letter-spacing:1px;
    text-shadow:0 0 10px var(--jn-g25); }
  .jn-pnl-neg { font-family:var(--jn-bebas);font-size:17px;color:var(--jn-red);letter-spacing:1px; }
  .jn-pnl-pct { font-size:8px;letter-spacing:1px;margin-top:1px; }
  .jn-pnl-pct.pos { color:rgba(0,255,65,0.5); }
  .jn-pnl-pct.neg { color:rgba(255,59,59,0.5); }

  /* duration */
  .jn-dur { font-size:9px;color:rgba(255,255,255,0.35);letter-spacing:1px; }

  /* result bar */
  .jn-result {
    display:flex;align-items:center;gap:6px;
  }
  .jn-result-bar { width:48px;height:3px;background:rgba(255,255,255,0.06);overflow:hidden; }
  .jn-result-fill-w { height:100%;background:var(--jn-g); }
  .jn-result-fill-l { height:100%;background:var(--jn-red); }

  /* note */
  .jn-note {
    font-size:8px;color:rgba(255,255,255,0.22);letter-spacing:1px;
    font-style:italic;max-width:140px;overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap;
  }
  .jn-note-add {
    font-size:8px;color:rgba(0,255,65,0.25);letter-spacing:2px;
    border:1px dashed rgba(0,255,65,0.15);padding:2px 8px;
    transition:all 0.15s;background:transparent;cursor:pointer;
  }
  .jn-note-add:hover { color:var(--jn-g);border-color:var(--jn-g50);background:var(--jn-g06); }

  /* expand row */
  .jn-expand {
    background:rgba(0,0,0,0.3);border-bottom:1px solid var(--jn-faint);
    padding:14px 18px 14px 62px;
  }
  .jn-expand-grid { display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:10px; }
  .jn-exp-lbl { font-size:7px;color:rgba(255,255,255,0.18);letter-spacing:3px;text-transform:uppercase;margin-bottom:4px; }
  .jn-exp-val { font-size:10px;color:rgba(255,255,255,0.55);letter-spacing:1px; }
  .jn-exp-val.gr { color:var(--jn-g); }
  .jn-exp-val.rd { color:var(--jn-red); }
  .jn-tag-row { display:flex;gap:6px;flex-wrap:wrap; }
  .jn-tag {
    font-size:7px;color:rgba(255,255,255,0.3);letter-spacing:2px;
    border:1px solid var(--jn-borderW);padding:2px 8px;
    clip-path:polygon(3px 0%,100% 0%,calc(100% - 3px) 100%,0% 100%);
  }
  .jn-tag.active { color:var(--jn-g);border-color:var(--jn-border);background:var(--jn-g06); }

  /* empty state */
  .jn-empty {
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    padding:64px 20px;gap:10px;
  }
  .jn-empty-icon { font-size:28px;opacity:0.1; }
  .jn-empty-lbl  { font-size:9px;color:rgba(255,255,255,0.12);letter-spacing:4px;text-transform:uppercase; }
  .jn-empty-cta  { font-size:8px;color:rgba(0,255,65,0.3);letter-spacing:3px;margin-top:4px; }

  /* win/loss summary bar */
  .jn-wl-bar-wrap {
    display:flex;height:3px;overflow:hidden;margin-bottom:14px;gap:1px;
  }
  .jn-wl-seg { height:100%;transition:width 0.6s ease; }
  .jn-wl-seg.w { background:var(--jn-g); }
  .jn-wl-seg.l { background:var(--jn-red); }
  .jn-wl-seg.n { background:rgba(255,255,255,0.08); }

  /* PAGINATION */
  .jn-page {
    display:flex;align-items:center;justify-content:space-between;
    padding:12px 18px;border-top:1px solid var(--jn-borderW);
  }
  .jn-page-info { font-size:8px;color:rgba(255,255,255,0.2);letter-spacing:2px; }
  .jn-page-btns { display:flex;gap:4px; }
  .jn-page-btn {
    font-size:8px;color:var(--jn-muted);letter-spacing:2px;
    border:1px solid var(--jn-borderW);padding:4px 10px;
    transition:all 0.15s;font-family:var(--jn-mono);cursor:pointer;
    clip-path:polygon(3px 0%,100% 0%,calc(100% - 3px) 100%,0% 100%);
    background:transparent;
  }
  .jn-page-btn:hover { border-color:var(--jn-border);color:#fff;background:var(--jn-g06); }
  .jn-page-btn.active { background:var(--jn-g06);color:var(--jn-g);border-color:var(--jn-border); }
  .jn-page-btn:disabled { opacity:0.3;cursor:not-allowed; }

  .jn-loading {
    display:flex;align-items:center;justify-content:center;
    padding:40px;font-size:8px;color:rgba(255,255,255,0.15);letter-spacing:4px;
    text-transform:uppercase;
  }

  .jn-fu { animation:jnFadeUp 0.35s ease both; }
  @keyframes jnFadeUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
  .jn-d1{animation-delay:0.05s} .jn-d2{animation-delay:0.1s}
  .jn-d3{animation-delay:0.15s} .jn-d4{animation-delay:0.2s}
`;

/* ── TYPES ── */
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

interface JournalSummaryData {
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: string;
  totalGrossPnl: string;
  totalFees: string;
  totalNetPnl: string;
  avgWin: string;
  avgLoss: string;
  largestWin: string;
  largestLoss: string;
  avgHoldingSeconds: number;
  profitFactor: string;
}

/* ── Mapped trade shape for the UI ── */
interface MappedTrade {
  id: string;
  sym: string;
  pair: string;
  side: "buy" | "sell";
  entry: number;
  exit: number;
  qty: number;
  pnl: number;
  pnlPct: number;
  dur: string;
  date: string;
  fee: number;
  slippage: number;
  tags: string[];
  note: string;
}

const ASSET_ICONS: Record<string, string> = { BTC: "\u20BF", ETH: "\u039E", SOL: "\u25CE" };
const ALL_TAGS = ["breakout", "momentum", "reversal", "swing", "support", "fakeout", "missed-stop", "scalp"];

const PAGE_SIZE = 25;

function formatHoldTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return h > 0 ? `${d}d ${String(h).padStart(2, "0")}h` : `${d}d`;
}

function mapTrade(t: ClosedTrade): MappedTrade {
  const sym = t.pair_symbol.split("/")[0] ?? t.pair_symbol;
  return {
    id: t.id,
    sym,
    pair: t.pair_symbol,
    side: t.direction === "LONG" ? "buy" : "sell",
    entry: parseFloat(t.entry_avg_price),
    exit: parseFloat(t.exit_avg_price),
    qty: parseFloat(t.entry_qty),
    pnl: parseFloat(t.net_pnl),
    pnlPct: parseFloat(t.return_pct),
    dur: formatHoldTime(t.holding_seconds),
    date: format(new Date(t.exit_at), "MMM dd \u00B7 HH:mm"),
    fee: parseFloat(t.total_fees),
    slippage: 0, // not tracked by backend
    tags: [],    // not tracked by backend yet
    note: "",    // not tracked by backend yet
  };
}

function fmtPrice(v: number): string {
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* ── CSV EXPORT ── */
function exportFilteredCsv(trades: MappedTrade[]) {
  const header = "Date,Asset,Direction,Entry,Exit,Size,PnL,PnL%,Duration,Fee,Note";
  const rows = trades.map((t) =>
    [
      t.date,
      t.pair,
      t.side === "buy" ? "LONG" : "SHORT",
      t.entry.toFixed(2),
      t.exit.toFixed(2),
      t.qty.toString(),
      t.pnl.toFixed(2),
      `${t.pnlPct.toFixed(2)}%`,
      t.dur,
      t.fee.toFixed(2),
      `"${t.note.replace(/"/g, '""')}"`,
    ].join(","),
  );
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "trade-journal.csv";
  a.click();
  URL.revokeObjectURL(url);
}

/* ── TRADE ROW ── */
function TradeRow({ trade, expanded, onToggle }: { trade: MappedTrade; expanded: boolean; onToggle: () => void }) {
  const isWin = trade.pnl >= 0;
  return (
    <>
      <tr
        className={isWin ? "win" : "loss"}
        style={{ cursor: "pointer" }}
        onClick={onToggle}
      >
        <td>
          <div className="jn-asset">
            <div className="jn-asset-icon">{ASSET_ICONS[trade.sym] ?? trade.sym[0]}</div>
            <div>
              <div className="jn-sym">{trade.sym}</div>
              <div className="jn-pair">{trade.pair}</div>
            </div>
          </div>
        </td>
        <td>
          <span className={trade.side === "buy" ? "jn-side-b" : "jn-side-s"}>
            {trade.side === "buy" ? "\u25B2 LONG" : "\u25BC SHORT"}
          </span>
        </td>
        <td className="r">
          <div className="jn-price">{fmtPrice(trade.entry)}</div>
        </td>
        <td className="r">
          <div className="jn-price">{fmtPrice(trade.exit)}</div>
        </td>
        <td className="r">
          <div className="jn-dur">{trade.qty} {trade.sym}</div>
        </td>
        <td className="r">
          <div className={isWin ? "jn-pnl-pos" : "jn-pnl-neg"}>
            {isWin ? "+" : ""}${Math.abs(trade.pnl).toFixed(2)}
          </div>
          <div className={`jn-pnl-pct ${isWin ? "pos" : "neg"}`}>
            {isWin ? "+" : ""}{trade.pnlPct.toFixed(2)}%
          </div>
        </td>
        <td><div className="jn-dur">{trade.dur}</div></td>
        <td><div className="jn-dur">{trade.date}</div></td>
        <td>
          {trade.note
            ? <div className="jn-note" title={trade.note}>{trade.note}</div>
            : <button className="jn-note-add" onClick={(e) => e.stopPropagation()}>+ NOTE</button>
          }
        </td>
        <td style={{ textAlign: "center" }}>
          <span style={{
            fontSize: 9, color: "var(--jn-muted)", transition: "transform 0.15s", display: "inline-block",
            transform: expanded ? "rotate(180deg)" : "none",
          }}>{"\u25BE"}</span>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={10} style={{ padding: 0, borderBottom: "1px solid var(--jn-faint)" }}>
            <div className="jn-expand">
              <div className="jn-expand-grid">
                <div>
                  <div className="jn-exp-lbl">Fee Paid</div>
                  <div className="jn-exp-val rd">${trade.fee.toFixed(2)}</div>
                </div>
                <div>
                  <div className="jn-exp-lbl">Slippage</div>
                  <div className="jn-exp-val">${trade.slippage}</div>
                </div>
                <div>
                  <div className="jn-exp-lbl">Net PnL</div>
                  <div className={`jn-exp-val ${isWin ? "gr" : "rd"}`}>
                    {isWin ? "+" : ""}${(trade.pnl - trade.fee).toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="jn-exp-lbl">Direction</div>
                  <div className="jn-exp-val">{trade.side.toUpperCase()}</div>
                </div>
                <div>
                  <div className="jn-exp-lbl">Move</div>
                  <div className={`jn-exp-val ${isWin ? "gr" : "rd"}`}>
                    {isWin ? "+" : ""}${Math.abs(trade.exit - trade.entry).toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="jn-exp-lbl">Result</div>
                  <div className={`jn-exp-val ${isWin ? "gr" : "rd"}`}>{isWin ? "WIN" : "LOSS"}</div>
                </div>
              </div>
              <div className="jn-tag-row">
                {ALL_TAGS.map((tag) => (
                  <span key={tag} className={`jn-tag${trade.tags.includes(tag) ? " active" : ""}`}>
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ─────────────────────────────────────────
   MAIN JOURNAL COMPONENT
───────────────────────────────────────── */
export default function JournalPage() {
  const pairs = useAppStore((s) => s.pairs);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [assetFilter, setAssetFilter] = useState("all");
  const [sideFilter, setSideFilter] = useState("all");
  const [resultFilter, setResultFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [clock, setClock] = useState("");

  const [rawTrades, setRawTrades] = useState<ClosedTrade[]>([]);
  const [summary, setSummary] = useState<JournalSummaryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  // Inject CSS
  useEffect(() => {
    const id = "tradr-journal-css";
    if (!document.getElementById(id)) {
      const s = document.createElement("style");
      s.id = id;
      s.textContent = JOURNAL_CSS;
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

  // Server-side filtering: map filter state to API params
  const pairId = assetFilter !== "all" ? assetFilter : undefined;
  const direction: "LONG" | "SHORT" | undefined =
    sideFilter === "buy" ? "LONG" : sideFilter === "sell" ? "SHORT" : undefined;
  const pnlSign: "positive" | "negative" | undefined =
    resultFilter === "win" ? "positive" : resultFilter === "loss" ? "negative" : undefined;

  const fetchPage = useCallback(async (cursor: string | null) => {
    setLoading(true);
    try {
      const params: Record<string, string | number | undefined> = {
        limit: PAGE_SIZE,
        cursor: cursor ?? undefined,
        pairId,
        direction,
        pnlSign,
      };
      // Clean undefined
      const cleanParams: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) cleanParams[k] = v;
      }

      const [journalRes, summaryRes] = await Promise.all([
        getJournal(cleanParams as Parameters<typeof getJournal>[0]),
        getJournalSummary(pairId),
      ]);

      setRawTrades(journalRes.data.trades ?? []);
      setNextCursor(journalRes.data.nextCursor ?? null);
      setSummary(summaryRes.data.summary ?? null);
    } catch {
      // Non-fatal — page shows empty state
    } finally {
      setLoading(false);
    }
  }, [pairId, direction, pnlSign]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCursorHistory([null]);
    setPageIndex(0);
    fetchPage(null);
  }, [fetchPage]);

  const goNextPage = () => {
    if (!nextCursor) return;
    const newIndex = pageIndex + 1;
    setCursorHistory((prev) => {
      const updated = [...prev];
      if (updated.length <= newIndex) updated.push(nextCursor);
      else updated[newIndex] = nextCursor;
      return updated;
    });
    setPageIndex(newIndex);
    fetchPage(nextCursor);
  };

  const goPrevPage = () => {
    if (pageIndex <= 0) return;
    const newIndex = pageIndex - 1;
    setPageIndex(newIndex);
    fetchPage(cursorHistory[newIndex] ?? null);
  };

  // Map API trades to UI shape
  const allMapped = rawTrades.map(mapTrade);

  // Client-side search filter (on top of server-side filters)
  const trades = allMapped.filter((t) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return t.sym.toLowerCase().includes(q) || t.pair.toLowerCase().includes(q) || t.note.toLowerCase().includes(q);
  });

  // Summary stats
  const total = summary?.totalTrades ?? 0;
  const wins = summary?.winCount ?? 0;
  const losses = summary?.lossCount ?? 0;
  const netPnl = parseFloat(summary?.totalNetPnl ?? "0");
  const winRate = total > 0 ? (summary?.winRate ?? "0") : "\u2014\u2014";
  const avgWin = wins > 0 ? `+$${parseFloat(summary?.avgWin ?? "0").toFixed(2)}` : "\u2014\u2014";
  const avgLoss = losses > 0 ? `-$${Math.abs(parseFloat(summary?.avgLoss ?? "0")).toFixed(2)}` : "\u2014\u2014";

  // Export handler — server CSV if no client search, else client CSV
  const handleExport = async () => {
    if (!search) {
      try {
        const res = await exportJournalCsv();
        const blob = new Blob([res.data], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "trade-journal.csv";
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        // Fallback to client-side
        exportFilteredCsv(trades);
      }
    } else {
      exportFilteredCsv(trades);
    }
  };

  // Pair dropdown options
  const pairOptions = pairs.filter((p) => p.is_active).map((p) => ({ id: p.id, symbol: p.symbol }));

  return (
    <div className="jn-wrap">
      <div className="jn-grid" /><div className="jn-scan" /><div className="jn-vig" />

      {/* PAGE HEADER */}
      <div className="jn-ph jn-fu">
        <div>
          <div className="jn-title">TRADE <span>JOURNAL</span></div>
          <div className="jn-meta">{clock}</div>
        </div>
        <div className="jn-actions">
          <button className="jn-btn jn-btn-g" onClick={handleExport}>{"\u2193"} EXPORT CSV</button>
          <button className="jn-btn jn-btn-p" onClick={() => window.location.href = "/trade"}>{"\u25B9"} NEW TRADE</button>
        </div>
      </div>

      {/* STAT CARDS */}
      <div className="jn-stats jn-fu jn-d1">
        <div className="jn-sc">
          <div className="jn-sc-lbl">Total Trades</div>
          <div className={`jn-sc-val ${total > 0 ? "wh" : "dm"}`}>{total || "\u2014\u2014"}</div>
          <div className="jn-sc-sub">{total > 0 ? `${wins}W \u00B7 ${losses}L` : "No trades yet"}</div>
          <div className="jn-sc-ghost">#</div>
        </div>
        <div className="jn-sc">
          <div className="jn-sc-lbl">Win Rate</div>
          <div className={`jn-sc-val ${winRate === "\u2014\u2014" ? "dm" : parseFloat(winRate) >= 50 ? "gr" : "rd"}`}>
            {winRate === "\u2014\u2014" ? winRate : `${winRate}%`}
          </div>
          <div className="jn-sc-sub">{wins > 0 ? `${wins} winning trades` : "\u2014"}</div>
          <div className="jn-sc-ghost">%</div>
        </div>
        <div className="jn-sc">
          <div className="jn-sc-lbl">Net PnL</div>
          <div className={`jn-sc-val ${total === 0 ? "dm" : netPnl >= 0 ? "gr" : "rd"}`}>
            {total === 0 ? "\u2014\u2014" : `${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(2)}`}
          </div>
          <div className="jn-sc-sub">Realized</div>
          <div className="jn-sc-ghost">$</div>
        </div>
        <div className="jn-sc">
          <div className="jn-sc-lbl">Avg Win</div>
          <div className={`jn-sc-val ${avgWin === "\u2014\u2014" ? "dm" : "gr"}`}>{avgWin}</div>
          <div className="jn-sc-sub">Per winning trade</div>
          <div className="jn-sc-ghost">W</div>
        </div>
        <div className="jn-sc">
          <div className="jn-sc-lbl">Avg Loss</div>
          <div className={`jn-sc-val ${avgLoss === "\u2014\u2014" ? "dm" : "rd"}`}>{avgLoss}</div>
          <div className="jn-sc-sub">Per losing trade</div>
          <div className="jn-sc-ghost">L</div>
        </div>
      </div>

      {/* WIN/LOSS BAR */}
      {total > 0 && (
        <div className="jn-wl-bar-wrap jn-fu jn-d2">
          {allMapped.map((t) => (
            <div
              key={t.id}
              className={`jn-wl-seg ${t.pnl >= 0 ? "w" : "l"}`}
              style={{ flex: 1 }}
              title={`${t.sym} ${t.pnl >= 0 ? "WIN" : "LOSS"} $${t.pnl.toFixed(2)}`}
            />
          ))}
        </div>
      )}

      {/* FILTER BAR */}
      <div className="jn-filterbar jn-fu jn-d2">
        <div className="jn-sel-wrap">
          <select className="jn-sel" value={assetFilter} onChange={(e) => setAssetFilter(e.target.value)}>
            <option value="all">ALL ASSETS</option>
            {pairOptions.map((p) => (
              <option key={p.id} value={p.id}>{p.symbol}</option>
            ))}
          </select>
        </div>
        <div className="jn-sel-wrap">
          <select className="jn-sel" value={sideFilter} onChange={(e) => setSideFilter(e.target.value)}>
            <option value="all">ALL DIRECTIONS</option>
            <option value="buy">LONG ONLY</option>
            <option value="sell">SHORT ONLY</option>
          </select>
        </div>
        <div className="jn-sel-wrap">
          <select className="jn-sel" value={resultFilter} onChange={(e) => setResultFilter(e.target.value)}>
            <option value="all">ALL TRADES</option>
            <option value="win">WINS ONLY</option>
            <option value="loss">LOSSES ONLY</option>
          </select>
        </div>
        <div className="jn-sep" />
        <div className="jn-search-wrap">
          <span className="jn-search-icon">{"\u26B2"}</span>
          <input
            placeholder="SEARCH SYMBOL OR NOTE..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="jn-sp" />
        <span style={{ fontSize: 8, color: "rgba(255,255,255,0.18)", letterSpacing: 2 }}>
          {trades.length} TRADE{trades.length !== 1 ? "S" : ""}
        </span>
      </div>

      {/* JOURNAL TABLE */}
      <div className="jn-card jn-fu jn-d3">
        <div className="jn-card-hdr">
          <span className="jn-card-title">Trade Log</span>
          <span className="jn-card-meta">CLICK ROW TO EXPAND</span>
        </div>

        {loading && rawTrades.length === 0 ? (
          <div className="jn-loading">LOADING TRADES...</div>
        ) : trades.length === 0 ? (
          <div className="jn-empty">
            <div className="jn-empty-icon">{"\u2637"}</div>
            <div className="jn-empty-lbl">{total === 0 ? "No trades yet" : "No trades match your filters"}</div>
            <div className="jn-empty-cta">{"\u25B9"} {total === 0 ? "START TRADING TO BUILD YOUR JOURNAL" : "ADJUST FILTERS OR MAKE YOUR FIRST TRADE"}</div>
          </div>
        ) : (
          <>
            <table className="jn-tbl">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Direction</th>
                  <th className="r">Entry</th>
                  <th className="r">Exit</th>
                  <th className="r">Size</th>
                  <th className="r sort">PnL</th>
                  <th>Duration</th>
                  <th>Date</th>
                  <th>Note</th>
                  <th style={{ width: 30 }}></th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <TradeRow
                    key={t.id}
                    trade={t}
                    expanded={expanded === t.id}
                    onToggle={() => setExpanded(expanded === t.id ? null : t.id)}
                  />
                ))}
              </tbody>
            </table>
            <div className="jn-page">
              <span className="jn-page-info">
                PAGE {pageIndex + 1} {total > 0 && `\u00B7 ${total} TOTAL TRADES`}
              </span>
              <div className="jn-page-btns">
                <button className="jn-page-btn" onClick={goPrevPage} disabled={pageIndex === 0 || loading}>
                  {"\u2190"} PREV
                </button>
                <button className="jn-page-btn active">{pageIndex + 1}</button>
                <button className="jn-page-btn" onClick={goNextPage} disabled={!nextCursor || loading}>
                  NEXT {"\u2192"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
