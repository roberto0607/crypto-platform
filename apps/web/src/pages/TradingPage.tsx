import { useState, useEffect } from "react";
import Decimal from "decimal.js-light";
import { useAppStore } from "@/stores/appStore";
import { useAuthStore } from "@/stores/authStore";
import { useTradingStore } from "@/stores/tradingStore";
import { CandlestickChart } from "@/components/trading/CandlestickChart";
import { getPositions } from "@/api/endpoints/analytics";
import { placeOrder } from "@/api/endpoints/trading";
import { getJournal } from "@/api/endpoints/journal";
import { useCompetitionMode } from "@/hooks/useCompetitionMode";
import client from "@/api/client";
import { formatDecimal, formatUsd } from "@/lib/decimal";
import type { Position, TradingPair, OrderBook as OrderBookType } from "@/types/api";
import type { AxiosError } from "axios";
import type { V1ApiError } from "@/types/api";

/* ─────────────────────────────────────────
   TRADE PAGE CSS — Circuit Noir
───────────────────────────────────────── */
const TRADE_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Oxanium:wght@400;600;700;800&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap');

  .tr-wrap, .tr-wrap *, .tr-wrap *::before, .tr-wrap *::after {
    box-sizing: border-box;
  }

  .tr-wrap {
    --g:      #00ff41;
    --g50:    rgba(0,255,65,0.5);
    --g25:    rgba(0,255,65,0.25);
    --g12:    rgba(0,255,65,0.12);
    --g06:    rgba(0,255,65,0.06);
    --g03:    rgba(0,255,65,0.03);
    --red:    #ff3b3b;
    --red25:  rgba(255,59,59,0.25);
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
    --bebas:  'Bebas Neue', sans-serif;
    --mono:   'Space Mono', monospace;
  }

  /* ── BG ── */
  .tr-grid {
    position:fixed;inset:0;pointer-events:none;z-index:0;
    background-image:
      linear-gradient(rgba(0,255,65,0.02) 1px,transparent 1px),
      linear-gradient(90deg,rgba(0,255,65,0.02) 1px,transparent 1px);
    background-size:48px 48px;
  }
  .tr-scan {
    position:fixed;inset:0;pointer-events:none;z-index:1;
    background:repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,0,0,0.05) 3px,rgba(0,0,0,0.05) 4px);
  }
  .tr-vig {
    position:fixed;inset:0;pointer-events:none;z-index:1;
    background:radial-gradient(ellipse 120% 120% at 50% 50%,transparent 25%,rgba(0,0,0,0.55) 100%);
  }

  /* ── TRADE LAYOUT ── */
  .tr-wrap {
    display:flex;flex-direction:column;height:100%;
    font-family:var(--mono);color:var(--text);
    position:relative;z-index:10;overflow:hidden;
    /* explicit fallback when flex parent doesn't resolve height */
    min-height:0;
    max-height:100%;
  }

  /* ── ASSET BAR ── */
  .tr-abar {
    display:flex;align-items:center;gap:12px;
    border-bottom:1px solid var(--border);
    background:rgba(4,4,4,0.97);flex-shrink:0;
    height:46px;padding:0 16px;
  }
  .tr-asset-tabs {
    display:flex;align-items:center;gap:2px;
    background:rgba(255,255,255,0.04);
    border:1px solid rgba(255,255,255,0.1);
    border-radius:6px;padding:3px;flex-shrink:0;
  }
  .tr-asset-tab {
    display:flex;align-items:center;gap:6px;
    padding:5px 16px;font-size:13px;letter-spacing:1.5px;
    font-family:var(--bebas);
    color:rgba(255,255,255,0.55);text-transform:uppercase;cursor:pointer;
    transition:all 0.15s;position:relative;
    border-radius:4px;border:1px solid transparent;
    white-space:nowrap;
  }
  .tr-asset-tab:hover { color:#fff;background:rgba(255,255,255,0.06); }
  .tr-asset-tab.active {
    color:var(--g);
    background:rgba(0,255,65,0.1);
    border-color:rgba(0,255,65,0.3);
    text-shadow:0 0 8px var(--g25);
  }
  .tr-asset-tab .tr-at-price {
    font-family:var(--bebas);font-size:14px;color:rgba(255,255,255,0.4);letter-spacing:1px;
  }
  .tr-asset-tab.active .tr-at-price { color:var(--g);text-shadow:0 0 12px var(--g25); }
  .tr-asset-tab .tr-at-chg { font-size:8px;letter-spacing:1px; }
  .tr-asset-tab .up { color:var(--g); }
  .tr-asset-tab .dn { color:var(--red); }

  .tr-price-hero {
    margin-left:auto;display:flex;align-items:baseline;gap:10px;
  }
  .tr-price-big {
    font-family:var(--bebas);font-size:28px;color:#fff;
    letter-spacing:2px;line-height:1;
  }
  .tr-price-big.up { color:var(--g);text-shadow:0 0 20px var(--g25); }
  .tr-price-big.dn { color:var(--red); }
  .tr-price-chg { font-size:9px;letter-spacing:2px; }
  .tr-price-meta {
    display:flex;gap:16px;margin-left:20px;padding-left:20px;
    border-left:1px solid var(--borderW);
  }
  .tr-pm-item { text-align:right; }
  .tr-pm-val { font-size:10px;color:rgba(255,255,255,0.6);letter-spacing:1px; }
  .tr-pm-lbl { font-size:7px;color:rgba(255,255,255,0.2);letter-spacing:2px;margin-top:1px; }

  /* ── MAIN BODY ── */
  .tr-body {
    display:grid;
    grid-template-columns:1fr 300px;
    grid-template-rows:1fr;
    grid-template-areas: "chart order";
    overflow:hidden;min-height:0;
    /* explicit height: viewport minus topbar(~41px) + p-1.5 padding(3px) + asset-bar(46px) + ticker(36px) */
    height: calc(100vh - 126px);
  }

  /* ── CHART AREA ── */
  .tr-chart-area {
    grid-area:chart;
    display:flex;flex-direction:column;
    overflow:hidden;
    height:100%;
    min-height:0;
  }

  /* ── TABS PANEL (in right column) ── */
  .tr-tabs-area {
    flex:1;min-height:0;
    display:flex;flex-direction:column;
    overflow:hidden;
  }
  .tr-tab-bar {
    display:flex;border-bottom:1px solid var(--borderW);
    background:rgba(15,15,15,0.98);flex-shrink:0;
  }
  .tr-tab {
    padding:9px 16px;font-size:9px;letter-spacing:2px;
    color:var(--muted);text-transform:uppercase;cursor:pointer;
    border-bottom:2px solid transparent;transition:all 0.15s;
  }
  .tr-tab:hover { color:#fff;background:var(--g06); }
  .tr-tab.active { color:var(--g);border-bottom-color:var(--g); }

  .tr-tab-content { flex:1;min-height:0;overflow-y:auto; }
  .tr-tab-content::-webkit-scrollbar { width:2px; }
  .tr-tab-content::-webkit-scrollbar-thumb { background:var(--border); }

  /* order book */
  .tr-ob { display:grid;grid-template-columns:1fr 1fr;gap:0;height:100%; }
  .tr-ob-col { overflow-y:auto;overflow-x:hidden; }
  .tr-ob-col::-webkit-scrollbar { width:2px; }
  .tr-ob-col::-webkit-scrollbar-thumb { background:var(--border); }
  .tr-ob-col:first-child { border-right:1px solid var(--borderW); }
  .tr-ob-hdr {
    display:grid;grid-template-columns:1fr 1fr;
    padding:6px 12px;border-bottom:1px solid var(--borderW);
    font-size:9px;color:rgba(255,255,255,0.45);letter-spacing:2px;
    text-transform:uppercase;
  }
  .tr-ob-hdr span:last-child { text-align:right; }
  .tr-ob-row {
    display:grid;grid-template-columns:1fr 1fr;
    padding:4px 12px;font-size:11px;color:rgba(255,255,255,0.8);position:relative;
    transition:background 0.1s;
  }
  .tr-ob-row:hover { background:var(--g06); }
  .tr-ob-row .fill {
    position:absolute;top:0;bottom:0;right:0;
    pointer-events:none;
  }
  .tr-ob-row.ask .fill { background:rgba(255,59,59,0.06); }
  .tr-ob-row.bid .fill { background:rgba(0,255,65,0.06); }
  .tr-ob-row span { position:relative;z-index:1;letter-spacing:1px; }
  .tr-ob-row.ask span.tr-ob-price { color:#ff3b3b; }
  .tr-ob-row.bid span.tr-ob-price { color:#00ff41; }
  .tr-ob-row span:last-child { text-align:right;color:rgba(255,255,255,0.4); }
  .tr-ob-spread {
    padding:6px 12px;text-align:center;font-size:9px;
    color:rgba(255,255,255,0.4);letter-spacing:2px;
    border-top:1px solid rgba(255,255,255,0.12);border-bottom:1px solid rgba(255,255,255,0.12);
    background:rgba(255,255,255,0.03);flex-shrink:0;
    font-family:var(--mono);
  }

  /* positions / orders table */
  .tr-ptbl { width:100%;border-collapse:collapse; }
  .tr-ptbl th {
    font-size:9px;color:rgba(255,255,255,0.45);letter-spacing:3px;
    text-transform:uppercase;padding:8px 16px;
    border-bottom:1px solid var(--borderW);text-align:left;font-weight:700;
  }
  .tr-ptbl td { padding:9px 16px;font-size:10px;border-bottom:1px solid var(--faint); }
  .tr-ptbl tr:last-child td { border-bottom:none; }
  .tr-ptbl tr:hover td { background:var(--g06); }
  .tr-sym { font-family:var(--bebas);font-size:16px;color:#fff; }
  .tr-side-b { font-size:7px;color:var(--g);letter-spacing:2px;border:1px solid rgba(0,255,65,0.3);padding:1px 5px; }
  .tr-side-s { font-size:7px;color:var(--red);letter-spacing:2px;border:1px solid rgba(255,59,59,0.3);padding:1px 5px; }
  .tr-pos { color:var(--g); }
  .tr-neg { color:var(--red); }
  .tr-dim { color:rgba(255,255,255,0.4); }

  .tr-empty-state {
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    padding:20px 24px;gap:6px;
  }
  .tr-es-lbl { font-size:11px;color:rgba(255,255,255,0.3);letter-spacing:2px;text-transform:uppercase; }
  .tr-es-cta { font-size:10px;color:rgba(0,255,65,0.45);letter-spacing:2px;margin-top:6px; }

  /* ── ORDER PANEL ── */
  .tr-order-panel {
    grid-area:order;
    background:rgba(5,5,5,0.97);
    display:flex;flex-direction:column;
    border-left:1px solid var(--border);
    height:100%;max-height:100%;overflow:hidden;
  }
  .tr-order-panel-top {
    flex-shrink:1;overflow-y:auto;min-height:0;max-height:45%;
  }
  .tr-order-panel-top::-webkit-scrollbar { width:2px; }
  .tr-order-panel-top::-webkit-scrollbar-thumb { background:var(--border); }
  .tr-order-panel-activity {
    flex-shrink:0;max-height:200px;overflow:hidden;
    display:flex;flex-direction:column;
    border-top:1px solid var(--border);
  }
  .tr-order-panel-activity .tr-tab-content {
    flex:1;min-height:0;overflow-y:auto;
  }
  .tr-order-panel-activity .tr-tab-content::-webkit-scrollbar { width:2px; }
  .tr-order-panel-activity .tr-tab-content::-webkit-scrollbar-thumb { background:var(--border); }
  .tr-order-panel-book {
    flex:1 1 0;min-height:0;overflow-y:auto;
    border-top:1px solid var(--border);
    padding-top:0;
  }

  .tr-op-section {
    padding:8px 14px;border-bottom:1px solid var(--borderW);
  }
  .tr-op-title {
    font-size:9px;color:rgba(255,255,255,0.55);letter-spacing:3px;
    text-transform:uppercase;margin-bottom:6px;
    display:flex;align-items:center;gap:7px;
  }
  .tr-op-title::before { content:'\\25CC';color:var(--g);font-size:10px; }

  /* side toggle BUY/SELL */
  .tr-side-toggle { display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--borderW); }
  .tr-st-buy,.tr-st-sell {
    padding:9px;text-align:center;font-family:var(--bebas);
    font-size:18px;letter-spacing:3px;transition:all 0.15s;
    border:2px solid transparent;cursor:pointer;
  }
  .tr-st-buy { color:rgba(0,255,65,0.3); }
  .tr-st-buy.active {
    background:var(--g);color:#000;
    box-shadow:0 0 20px var(--g25);
  }
  .tr-st-buy:not(.active):hover { background:var(--g06);color:var(--g); }
  .tr-st-sell { color:rgba(255,59,59,0.3);border-left:1px solid var(--borderW); }
  .tr-st-sell.active {
    background:var(--red);color:#fff;
    box-shadow:0 0 20px var(--red25);
  }
  .tr-st-sell:not(.active):hover { background:var(--red12);color:var(--red); }

  /* order type */
  .tr-type-toggle { display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px; }
  .tr-tt {
    padding:5px;text-align:center;font-size:11px;letter-spacing:3px;
    color:var(--muted);border:1px solid var(--borderW);transition:all 0.15s;cursor:pointer;
  }
  .tr-tt.active { color:var(--g);border-color:var(--border);background:var(--g06); }
  .tr-tt:not(.active):hover { color:#fff;background:var(--faint); }

  /* input fields */
  .tr-field { margin-top:5px; }
  .tr-field-lbl {
    font-size:10px;color:rgba(255,255,255,0.6);letter-spacing:2px;
    text-transform:uppercase;margin-bottom:6px;display:block;
  }
  .tr-field-wrap {
    display:flex;align-items:center;
    border:1px solid var(--borderW);background:rgba(255,255,255,0.04);
    transition:border-color 0.2s;
    clip-path:polygon(5px 0%,100% 0%,calc(100% - 5px) 100%,0% 100%);
  }
  .tr-field-wrap:focus-within { border-color:var(--g50);box-shadow:0 0 12px rgba(0,255,65,0.06); }
  .tr-field-wrap input {
    flex:1;background:transparent;border:none;outline:none;
    font-family:var(--mono);font-size:13px;color:rgba(255,255,255,0.9);
    padding:7px 10px;letter-spacing:1px;
  }
  .tr-field-wrap input::placeholder { color:rgba(255,255,255,0.15); }
  .tr-field-unit {
    font-size:10px;color:rgba(255,255,255,0.6);letter-spacing:2px;
    padding:0 12px;border-left:1px solid var(--borderW);flex-shrink:0;
  }

  /* pct buttons */
  .tr-pct-row { display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:2px; }
  .tr-pct {
    padding:3px 0;text-align:center;font-size:10px;letter-spacing:1px;
    color:rgba(255,255,255,0.7);border:1px solid rgba(255,255,255,0.2);transition:all 0.15s;cursor:pointer;
  }
  .tr-pct:hover { color:#fff;border-color:var(--g);background:rgba(0,230,118,0.08); }
  .tr-pct.active { color:var(--g);border-color:var(--g);background:var(--g06); }

  /* order summary */
  .tr-summary { margin-top:6px;border-top:1px solid var(--borderW);padding-top:6px; }
  .tr-sum-row {
    display:flex;justify-content:space-between;
    font-size:11px;padding:3px 0;
  }
  .tr-sum-lbl { color:rgba(255,255,255,0.55);letter-spacing:1px; }
  .tr-sum-val { color:rgba(255,255,255,0.9); }

  /* place order button */
  .tr-place-btn {
    width:100%;padding:8px;border:none;margin-top:6px;
    font-family:var(--mono);font-size:12px;font-weight:700;
    letter-spacing:4px;text-transform:uppercase;cursor:pointer;
    position:relative;overflow:hidden;transition:all 0.2s;
    clip-path:polygon(8px 0%,100% 0%,calc(100% - 8px) 100%,0% 100%);
  }
  .tr-place-btn::before {
    content:'';position:absolute;inset:0;
    background:linear-gradient(90deg,transparent,rgba(255,255,255,0.2),transparent);
    transform:translateX(-100%);transition:transform 0.5s;
  }
  .tr-place-btn:hover::before { transform:translateX(100%); }
  .tr-place-btn.buy {
    background:var(--g);color:#000;
  }
  .tr-place-btn.buy:hover { background:#2dff5c;box-shadow:0 0 28px var(--g25);transform:translateY(-1px); }
  .tr-place-btn.sell {
    background:var(--red);color:#fff;
  }
  .tr-place-btn.sell:hover { background:#ff6060;box-shadow:0 0 28px var(--red25);transform:translateY(-1px); }
  .tr-place-btn.success { background:#00cc33;color:#000; }
  .tr-place-btn.error { background:#cc0000;color:#fff; }
  .tr-place-btn:disabled { opacity:0.6;cursor:not-allowed; }
  .tr-place-btn:disabled::before { display:none; }

  /* balance */
  .tr-balance-row {
    display:flex;justify-content:space-between;align-items:center;
    padding:4px 14px;border-top:1px solid var(--borderW);
    font-size:10px;
  }
  .tr-bal-lbl { color:rgba(255,255,255,0.4);letter-spacing:1px; }
  .tr-bal-val { color:rgba(255,255,255,0.8);letter-spacing:1px; }
  .tr-bal-val span { color:var(--g); }

  /* open position summary in order panel */
  .tr-pos-card {
    margin:0 16px 0;border:1px solid var(--borderW);
    background:rgba(0,0,0,0.3);overflow:hidden;
  }
  .tr-pos-card::before {
    content:'';display:block;height:1px;
    background:linear-gradient(90deg,transparent,var(--g),transparent);opacity:0.4;
  }
  .tr-pos-row {
    display:flex;justify-content:space-between;align-items:center;
    padding:5px 12px;border-bottom:1px solid var(--faint);
    font-size:11px;
  }
  .tr-pos-row:last-child { border-bottom:none; }
  .tr-pos-key { color:rgba(255,255,255,0.45);letter-spacing:1px; }
  .tr-pos-val { color:rgba(255,255,255,0.85); }

  /* compact order panel header */
  .tr-op-compact-header {
    display:flex;justify-content:space-between;align-items:center;
    padding:7px 14px;border-bottom:1px solid var(--borderW);
  }
  .tr-op-symbol {
    font-family:var(--bebas);font-size:16px;letter-spacing:2px;
    color:rgba(255,255,255,0.6);
  }
  .tr-op-live-price {
    font-family:var(--bebas);font-size:18px;letter-spacing:1px;
    color:#fff;
  }

  /* section divider label */
  .tr-panel-section-label {
    font-size:7px;letter-spacing:4px;color:rgba(255,255,255,0.35);
    padding:8px 16px 0;text-transform:uppercase;
  }

  /* animations */
  @keyframes tr-fadeup { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
  .tr-fu { animation:tr-fadeup 0.35s ease both; }
  .tr-d1{animation-delay:0.04s} .tr-d2{animation-delay:0.08s}
  .tr-d3{animation-delay:0.13s} .tr-d4{animation-delay:0.18s}

  /* ── DIRECTION TOGGLE (LONG/SHORT) ── */
  .tr-direction-toggle { display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--borderW); }
  .tr-dir-btn {
    padding:6px;text-align:center;font-family:var(--bebas);
    font-size:18px;letter-spacing:3px;transition:all 0.15s;
    border:2px solid transparent;cursor:pointer;
  }
  .tr-dir-long { color:rgba(0,255,65,0.3); }
  .tr-dir-long.active {
    background:var(--g);color:#000;
    box-shadow:0 0 20px var(--g25);
  }
  .tr-dir-long:not(.active):hover { background:var(--g06);color:var(--g); }
  .tr-dir-short { color:rgba(255,59,59,0.3);border-left:1px solid var(--borderW); }
  .tr-dir-short.active {
    background:var(--red);color:#fff;
    box-shadow:0 0 20px var(--red25);
  }
  .tr-dir-short:not(.active):hover { background:var(--red12);color:var(--red); }

  /* ── CLOSE POSITION ── */
  .tr-action-btn {
    padding:2px 8px;font-family:var(--mono);font-size:9px;font-weight:700;
    letter-spacing:2px;cursor:pointer;border:none;transition:all 0.15s;
    background:transparent;
  }
  .tr-action-btn.cancel {
    color:var(--red);border:1px solid rgba(255,59,59,0.3);
  }
  .tr-action-btn.cancel:hover {
    background:rgba(255,59,59,0.08);border-color:rgba(255,59,59,0.5);
  }
  .tr-action-btn.close {
    color:var(--yellow);border:1px solid rgba(255,215,0,0.3);
  }
  .tr-action-btn.close:hover {
    background:rgba(255,215,0,0.08);border-color:rgba(255,215,0,0.5);
  }
  .tr-action-btn:disabled { opacity:0.5;cursor:not-allowed; }

  .tr-close-section {
    padding:4px 14px;
  }
  .tr-close-btn {
    width:100%;padding:6px;border:1px solid rgba(255,215,0,0.35);
    background:rgba(255,215,0,0.06);color:var(--yellow);
    font-family:var(--mono);font-size:11px;font-weight:700;
    letter-spacing:3px;text-transform:uppercase;cursor:pointer;
    transition:all 0.15s;position:relative;overflow:hidden;
    clip-path:polygon(6px 0%,100% 0%,calc(100% - 6px) 100%,0% 100%);
  }
  .tr-close-btn:hover {
    background:rgba(255,215,0,0.12);border-color:rgba(255,215,0,0.5);
    box-shadow:0 0 16px rgba(255,215,0,0.1);
  }
  .tr-close-btn:disabled { opacity:0.5;cursor:not-allowed; }

  /* ── POSITION BADGE ── */
  .tr-pos-badge {
    font-size:7px;letter-spacing:2px;padding:1px 6px;display:inline-block;
  }
  .tr-pos-badge.long {
    color:var(--g);border:1px solid rgba(0,255,65,0.3);
  }
  .tr-pos-badge.short {
    color:var(--red);border:1px solid rgba(255,59,59,0.3);
  }

  /* ticker provided by AppLayout */
`;

/* ── STATIC DATA ── */
const TABS = ["ORDERS", "HISTORY"];

const ERROR_MAP: Record<string, string> = {
  insufficient_balance: "Insufficient balance",
  insufficient_liquidity: "Insufficient liquidity",
  risk_check_failed: "Risk check failed",
  governance_check_failed: "Session error — please refresh",
  quota_exceeded: "Order limit exceeded",
  pair_queue_overloaded: "Queue full, retry shortly",
  trading_paused_global: "Trading is paused",
  trading_paused_pair: "Trading is paused for this pair",
  server_shutting_down: "Server restarting, retry shortly",
};

/* ── NUMBER FORMATTERS ── */
function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ── ORDER BOOK FORMATTERS ── */
function formatBookQty(qty: string): string {
  const n = parseFloat(qty);
  if (n === 0) return "0";
  if (n >= 10) return n.toFixed(2);
  if (n >= 1) return n.toFixed(3);
  if (n >= 0.01) return n.toFixed(4);
  return n.toFixed(5);
}

function formatBookPrice(price: string): string {
  const n = parseFloat(price);
  if (n >= 1000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(3);
  return n.toFixed(5);
}

/* ── ORDER BOOK DATA ── */
interface BookRow {
  price: string;
  qty: string;
}

/* ── ORDER BOOK ── */
function OrderBookPanel({
  liveBook,
}: {
  liveBook: OrderBookType | null;
}) {
  // Format live book levels for display (show all levels, not just 8)
  const book = (() => {
    if (liveBook && liveBook.asks.length > 0 && liveBook.bids.length > 0) {
      // Asks from API: ascending (best/lowest first). Reverse so highest is at top, best ask at bottom near spread.
      const asks = liveBook.asks.map((lvl) => ({
        price: formatBookPrice(lvl.price), qty: formatBookQty(lvl.qty),
      })).reverse();
      // Bids from API: descending (best/highest first). Keep as-is so best bid is at top near spread.
      const bids = liveBook.bids.map((lvl) => ({
        price: formatBookPrice(lvl.price), qty: formatBookQty(lvl.qty),
      }));
      return { asks, bids };
    }
    return { asks: [] as BookRow[], bids: [] as BookRow[] };
  })();

  // Use raw liveBook prices for spread (formatted strings have commas that break parseFloat)
  const bestAskPrice = liveBook?.asks?.[0] ? parseFloat(liveBook.asks[0].price) : 0;
  const bestBidPrice = liveBook?.bids?.[0] ? parseFloat(liveBook.bids[0].price) : 0;
  const spreadVal = bestAskPrice - bestBidPrice;
  const spread = spreadVal.toFixed(2);
  const spreadPct = bestBidPrice > 0 ? ((spreadVal / bestBidPrice) * 100).toFixed(3) : "0.000";

  // Sum ALL levels for true depth imbalance (use raw liveBook to avoid formatted-string parsing issues)
  const rawBids = liveBook?.bids ?? [];
  const rawAsks = liveBook?.asks ?? [];
  const totalBidQty = rawBids.reduce((sum, r) => sum + parseFloat(r.qty), 0);
  const totalAskQty = rawAsks.reduce((sum, r) => sum + parseFloat(r.qty), 0);
  const totalQty = totalBidQty + totalAskQty || 1;

  // Max qty across all levels for relative bar scaling
  const maxQty = Math.max(
    ...rawBids.map((r) => parseFloat(r.qty)),
    ...rawAsks.map((r) => parseFloat(r.qty)),
    0.0001, // floor to avoid division by zero
  );

  const hasBook = book.asks.length > 0 && book.bids.length > 0;

  return (
    <div className="tr-ob">
      <div className="tr-ob-col">
        {!hasBook && (
          <div style={{
            padding: "8px 12px", textAlign: "center",
            fontSize: 9, letterSpacing: 2, color: "rgba(255,255,255,0.3)",
            fontFamily: "var(--mono)",
          }}>WAITING FOR BOOK DATA...</div>
        )}
        <div className="tr-ob-hdr">
          <span>PRICE</span>
          <span>QTY</span>
        </div>
        {book.asks.map((r, i) => (
          <div key={i} className="tr-ob-row ask">
            <div className="fill" style={{ width: `${(parseFloat(r.qty) / maxQty) * 100}%` }} />
            <span className="tr-ob-price">{r.price}</span>
            <span className="tr-dim">{r.qty}</span>
          </div>
        ))}
        <div className="tr-ob-spread">
          SPREAD ${spread} ({spreadPct}%)
        </div>
        {book.bids.map((r, i) => (
          <div key={i} className="tr-ob-row bid">
            <div className="fill" style={{ width: `${(parseFloat(r.qty) / maxQty) * 100}%` }} />
            <span className="tr-ob-price">{r.price}</span>
            <span className="tr-dim">{r.qty}</span>
          </div>
        ))}
      </div>
      <div
        className="tr-ob-col"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: 20,
          gap: 12,
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              fontFamily: "var(--bebas)",
              fontSize: 28,
              color: "var(--g)",
              letterSpacing: 2,
            }}
          >
            {((totalBidQty * 100) / totalQty).toFixed(0)}%
          </div>
          <div
            style={{
              fontSize: 7,
              color: "rgba(0,255,65,0.4)",
              letterSpacing: 3,
              marginTop: 2,
            }}
          >
            BID DEPTH
          </div>
        </div>
        <div style={{ width: 1, height: 32, background: "var(--borderW)" }} />
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              fontFamily: "var(--bebas)",
              fontSize: 28,
              color: "var(--red)",
              letterSpacing: 2,
            }}
          >
            {((totalAskQty * 100) / totalQty).toFixed(0)}%
          </div>
          <div
            style={{
              fontSize: 7,
              color: "rgba(255,59,59,0.4)",
              letterSpacing: 3,
              marginTop: 2,
            }}
          >
            ASK DEPTH
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── ORDER PANEL ── */
function OrderPanel({
  pair,
  position,
  quoteBalance,
  onOrderFilled,
}: {
  pair: TradingPair;
  position: Position | null;
  quoteBalance: number;
  onOrderFilled: () => void;
}) {
  const orderType = useTradingStore((s) => s.orderType);
  const qty = useTradingStore((s) => s.qty);
  const limitPrice = useTradingStore((s) => s.limitPrice);
  const orderSubmitting = useTradingStore((s) => s.orderSubmitting);
  const appInitialized = useAppStore((s) => s.initialized);
  const setOrderSide = useTradingStore((s) => s.setOrderSide);
  const setOrderType = useTradingStore((s) => s.setOrderType);
  const setQty = useTradingStore((s) => s.setQty);
  const setLimitPrice = useTradingStore((s) => s.setLimitPrice);
  const submitOrder = useTradingStore((s) => s.submitOrder);
  const snapshot = useTradingStore((s) => s.snapshot);
  const selectedPairId = useTradingStore((s) => s.selectedPairId);

  const [activeMode, setActiveMode] = useState<"LONG" | "SHORT">("LONG");
  const [pct, setPct] = useState<number | null>(null);
  const [btnState, setBtnState] = useState<"idle" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  // Clear stale error state on pair change or remount
  useEffect(() => {
    setBtnState("idle");
    setErrorMsg("");
  }, [selectedPairId]);

  const [baseSymbol] = pair.symbol.split("/") as [string, string];
  const currentPrice = snapshot?.last ? parseFloat(snapshot.last) : (pair.last_price ? parseFloat(pair.last_price) : 0);

  const effectivePrice =
    orderType === "LIMIT" && limitPrice ? parseFloat(limitPrice) : currentPrice;

  const qtyNum = qty ? parseFloat(qty) : 0;
  const estTotal = qtyNum && effectivePrice ? (qtyNum * effectivePrice).toFixed(2) : null;
  const estFee = estTotal ? (parseFloat(estTotal) * (pair.taker_fee_bps / 10000)).toFixed(2) : null;

  // Derive position direction and absolute size
  const posQty = position ? parseFloat(position.base_qty) : 0;
  const hasPosition = position && posQty !== 0;
  const posDirection: "LONG" | "SHORT" | null = hasPosition ? (posQty > 0 ? "LONG" : "SHORT") : null;
  const posAbsQty = Math.abs(posQty);

  // Sync activeMode → orderSide
  const handleModeChange = (mode: "LONG" | "SHORT") => {
    setActiveMode(mode);
    setOrderSide(mode === "LONG" ? "BUY" : "SELL");
  };

  // Initialize orderSide on mount
  useEffect(() => {
    setOrderSide(activeMode === "LONG" ? "BUY" : "SELL");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePct = (p: number) => {
    setPct(p);
    if (currentPrice > 0) {
      const dollars = quoteBalance * (p / 100);
      setQty((dollars / currentPrice).toFixed(4));
    }
  };

  const handlePlaceOrder = async () => {
    if (!appInitialized) return;
    setErrorMsg("");
    setBtnState("idle");
    try {
      await submitOrder();
      setBtnState("success");
      setPct(null);
      onOrderFilled();
      setTimeout(() => setBtnState("idle"), 2000);
    } catch (err) {
      const axErr = err as AxiosError<V1ApiError | { error: string }>;
      const status = axErr.response?.status;
      const data = axErr.response?.data;
      let msg = "FAILED \u2014 RETRY";
      if (!axErr.response) {
        msg = "Server offline \u2014 check backend";
      } else if (status === 401 || status === 403) {
        msg = "Session expired \u2014 re-login";
      } else if (data) {
        const code = "code" in data ? data.code : "error" in data ? data.error : "";
        const message = "message" in data ? data.message : "";
        msg = ERROR_MAP[code] ?? (typeof message === "string" && message ? message : "FAILED \u2014 RETRY");
      }
      setErrorMsg(msg);
      setBtnState("error");
      setTimeout(() => setBtnState("idle"), 3000);
    }
  };


  const isLong = activeMode === "LONG";
  const type = orderType === "MARKET" ? "market" : "limit";

  const btnLabel = (() => {
    if (orderSubmitting) return "PLACING...";
    if (btnState === "success") return "ORDER PLACED";
    if (btnState === "error") return errorMsg || "FAILED \u2014 RETRY";
    const arrow = isLong ? "\u25B2" : "\u25BC";
    return `${arrow} OPEN ${type.toUpperCase()} ${isLong ? "LONG" : "SHORT"}`;
  })();

  const btnClass = (() => {
    if (btnState === "success") return "tr-place-btn success";
    if (btnState === "error") return "tr-place-btn error";
    return `tr-place-btn ${isLong ? "buy" : "sell"}`;
  })();

  const pnlValue = position
    ? (currentPrice - parseFloat(position.avg_entry_price)) * parseFloat(position.base_qty)
    : 0;

  return (
    <>
      {/* COMPACT HEADER */}
      <div className="tr-op-compact-header">
        <span className="tr-op-symbol">{baseSymbol}</span>
        <span className="tr-op-live-price">
          ${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
        </span>
      </div>

      {/* DIRECTION TOGGLE — LONG / SHORT */}
      <div className="tr-op-section" style={{ paddingBottom: 0 }}>
        <div className="tr-direction-toggle">
          <div
            className={`tr-dir-btn tr-dir-long${activeMode === "LONG" ? " active" : ""}`}
            onClick={() => handleModeChange("LONG")}
          >
            LONG
          </div>
          <div
            className={`tr-dir-btn tr-dir-short${activeMode === "SHORT" ? " active" : ""}`}
            onClick={() => handleModeChange("SHORT")}
          >
            SHORT
          </div>
        </div>

        {/* ORDER TYPE */}
        <div className="tr-type-toggle">
          {(["MARKET", "LIMIT"] as const).map((t) => (
            <div
              key={t}
              className={`tr-tt${orderType === t ? " active" : ""}`}
              onClick={() => {
                setOrderType(t);
                if (t === "LIMIT" && !limitPrice && snapshot?.last) {
                  setLimitPrice(snapshot.last);
                }
              }}
            >
              {t}
            </div>
          ))}
        </div>
      </div>

      {/* FIELDS */}
      <div className="tr-op-section">
        {orderType === "LIMIT" && (
          <div className="tr-field">
            <label className="tr-field-lbl">Limit Price</label>
            <div className="tr-field-wrap">
              <input
                type="number"
                placeholder={currentPrice ? currentPrice.toFixed(2) : "0.00"}
                value={limitPrice}
                onChange={(e) => setLimitPrice(e.target.value)}
              />
              <span className="tr-field-unit">USD</span>
            </div>
          </div>
        )}

        <div className="tr-field">
          <label className="tr-field-lbl">Quantity</label>
          <div className="tr-field-wrap">
            <input
              type="number"
              placeholder="0.0000"
              value={qty}
              onChange={(e) => {
                setQty(e.target.value);
                setPct(null);
              }}
            />
            <span className="tr-field-unit">{baseSymbol}</span>
          </div>
        </div>

        <div className="tr-pct-row">
          {[25, 50, 75, 100].map((p) => (
            <div
              key={p}
              className={`tr-pct${pct === p ? " active" : ""}`}
              onClick={() => handlePct(p)}
            >
              {p}%
            </div>
          ))}
        </div>

        {/* SUMMARY */}
        <div className="tr-summary">
          <div className="tr-sum-row">
            <span className="tr-sum-lbl">PRICE</span>
            <span className="tr-sum-val">
              {orderType === "LIMIT" && limitPrice
                ? fmtUsd(parseFloat(limitPrice))
                : "MARKET"}
            </span>
          </div>
          <div className="tr-sum-row">
            <span className="tr-sum-lbl">ESTIMATED</span>
            <span className="tr-sum-val">
              {estTotal ? fmtUsd(parseFloat(estTotal)) : "--"}
            </span>
          </div>
          <div className="tr-sum-row">
            <span className="tr-sum-lbl">FEE ({pair.taker_fee_bps} bps)</span>
            <span className="tr-sum-val">{estFee ?? "--"}</span>
          </div>
          <div
            className="tr-sum-row"
            style={{
              marginTop: 4,
              paddingTop: 8,
              borderTop: "1px solid var(--borderW)",
            }}
          >
            <span className="tr-sum-lbl" style={{ color: "rgba(255,255,255,0.35)" }}>
              TOTAL
            </span>
            <span className="tr-sum-val" style={{ color: "#fff" }}>
              {estTotal && estFee
                ? fmtUsd(parseFloat(estTotal) + parseFloat(estFee))
                : "--"}
            </span>
          </div>
        </div>

        {/* PLACE ORDER */}
        <button
          className={btnClass}
          disabled={orderSubmitting || !qty || !appInitialized}
          onClick={handlePlaceOrder}
        >
          {btnLabel}
        </button>
      </div>

      {/* BALANCE */}
      <div className="tr-balance-row">
        <span className="tr-bal-lbl">AVAILABLE</span>
        <span className="tr-bal-val">
          <span>${formatDecimal(quoteBalance.toString(), 2)}</span> USD
        </span>
      </div>

      {/* OPEN POSITION */}
      <div className="tr-op-section">
        <div className="tr-pos-card">
          <div className="tr-pos-row">
            <span className="tr-pos-key">SIDE</span>
            <span className="tr-pos-val">
              {posDirection ? (
                <span className={`tr-pos-badge ${posDirection.toLowerCase()}`}>{posDirection}</span>
              ) : (
                <span style={{ color: "rgba(255,255,255,0.2)" }}>{"\u2014"}</span>
              )}
            </span>
          </div>
          <div className="tr-pos-row">
            <span className="tr-pos-key">SIZE</span>
            <span className="tr-pos-val" style={!hasPosition ? { color: "rgba(255,255,255,0.2)" } : undefined}>
              {hasPosition ? `${formatDecimal(posAbsQty.toString(), 8)} ${baseSymbol}` : "\u2014"}
            </span>
          </div>
          <div className="tr-pos-row">
            <span className="tr-pos-key">ENTRY</span>
            <span className="tr-pos-val" style={!hasPosition ? { color: "rgba(255,255,255,0.2)" } : undefined}>
              {hasPosition ? formatUsd(position.avg_entry_price) : "\u2014"}
            </span>
          </div>
          <div className="tr-pos-row">
            <span className="tr-pos-key">PNL</span>
            <span
              className="tr-pos-val"
              style={
                !hasPosition
                  ? { color: "rgba(255,255,255,0.2)" }
                  : { color: pnlValue >= 0 ? "var(--g)" : "var(--red)" }
              }
            >
              {hasPosition ? (pnlValue >= 0 ? "+" : "") + formatUsd(String(pnlValue.toFixed(2))) : "\u2014"}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

/* ─────────────────────────────────────────
   MAIN TRADE COMPONENT
───────────────────────────────────────── */
export default function TradingPage() {
  const pairs = useAppStore((s) => s.pairs);
  const wallets = useAppStore((s) => s.wallets);
  const selectedPairId = useTradingStore((s) => s.selectedPairId);
  const selectPair = useTradingStore((s) => s.selectPair);
  const snapshot = useTradingStore((s) => s.snapshot);
  const liveOrderBook = useTradingStore((s) => s.orderBook);
  const openOrders = useTradingStore((s) => s.openOrders);
  const cancelOrder = useTradingStore((s) => s.cancelOrder);
  const [tab, setTab] = useState("ORDERS");
  const [actionStates, setActionStates] = useState<Record<string, "idle" | "loading" | "error">>({});
  const [positions, setPositions] = useState<Position[]>([]);
  const [fundingRate, setFundingRate] = useState(0);
  const [historyTrades, setHistoryTrades] = useState<any[]>([]);

  const userId = useAuthStore((s) => s.user?.id);
  const { isInCompetition, activeMatch } = useCompetitionMode();

  // Default to first pair on mount
  useEffect(() => {
    if (!selectedPairId && pairs.length > 0) {
      selectPair(pairs[0]!.id);
    }
  }, [selectedPairId, pairs, selectPair]);

  // Inject CSS
  useEffect(() => {
    const id = "tradr-trade-css";
    if (!document.getElementById(id)) {
      const s = document.createElement("style");
      s.id = id;
      s.textContent = TRADE_CSS;
      document.head.appendChild(s);
    }
  }, []);

  // Fetch positions
  const refreshPositions = () => {
    getPositions()
      .then((res) => setPositions(res.data.positions))
      .catch(() => {});
  };

  useEffect(() => {
    refreshPositions();
  }, [selectedPairId]);

  // Refresh positions on SSE trade events
  useEffect(() => {
    const handler = () => refreshPositions();
    window.addEventListener("sse:trade.created", handler);
    return () => window.removeEventListener("sse:trade.created", handler);
  }, []);

  // Fetch funding rate from basis endpoint
  useEffect(() => {
    const fetchFunding = async () => {
      try {
        const res = await client.get<{ ok: boolean; fundingRate: number }>("/market/basis");
        setFundingRate(res.data.fundingRate ?? 0);
      } catch { /* non-fatal */ }
    };
    fetchFunding();
    const interval = setInterval(fetchFunding, 60_000);
    return () => clearInterval(interval);
  }, []);

  // Fetch trade history when HISTORY tab is active or pair changes
  useEffect(() => {
    if (tab !== "HISTORY") return;
    getJournal({ pairId: selectedPairId || undefined, limit: 20 })
      .then((res) => setHistoryTrades(res.data.trades ?? []))
      .catch(() => setHistoryTrades([]));
  }, [tab, selectedPairId]);

  // API only returns active pairs (WHERE is_active = true), no need to re-filter
  const activePairs = pairs;
  const selectedPair = pairs.find((p) => p.id === selectedPairId);

  // Current price: prefer SSE snapshot, fall back to pair.last_price
  const currentPrice = snapshot?.last
    ? parseFloat(snapshot.last)
    : selectedPair?.last_price
      ? parseFloat(selectedPair.last_price)
      : 0;

  // Quote wallet balance (USD)
  const quoteAssetId = selectedPair?.quote_asset_id;
  const quoteWallet = wallets.find((w) => w.asset_id === quoteAssetId);
  const quoteBalance = quoteWallet
    ? new Decimal(quoteWallet.balance).minus(quoteWallet.reserved ?? "0").toNumber()
    : 0;

  // Position for selected pair
  const currentPosition = positions.find((p) => p.pair_id === selectedPairId) ?? null;

  if (!selectedPair) {
    return (
      <div className="flex items-center justify-center h-full text-white/30 font-mono text-sm tracking-widest">
        NO PAIRS AVAILABLE
      </div>
    );
  }

  return (
    <div className="tr-wrap">
      {/* background overlays removed — too distracting */}

      {/* ASSET BAR */}
      <div className="tr-abar tr-fu">
        <div className="tr-asset-tabs">
          {activePairs.slice(0, 6).map((p) => {
            const isActive = p.id === selectedPairId;
            const price = isActive && snapshot?.last ? parseFloat(snapshot.last) : (p.last_price ? parseFloat(p.last_price) : 0);
            return (
              <div
                key={p.id}
                className={`tr-asset-tab${isActive ? " active" : ""}`}
                onClick={() => selectPair(p.id)}
              >
                <span>{p.symbol.split("/")[0]}</span>
                <span className="tr-at-price">
                  ${price.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </div>
            );
          })}
        </div>

        <div className="tr-price-hero">
          <span className="tr-price-big up">
            ${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </span>
          <div className="tr-price-meta">
            <div className="tr-pm-item">
              <div className="tr-pm-val" style={{ color: fundingRate > 0 ? "var(--g)" : fundingRate < 0 ? "var(--red)" : undefined }}>
                {fundingRate !== 0
                  ? `${fundingRate > 0 ? "+" : ""}${(fundingRate * 100).toFixed(4)}%`
                  : "\u2014"}
              </div>
              <div className="tr-pm-lbl">FUNDING</div>
            </div>
            <div className="tr-pm-item">
              <div className="tr-pm-val" style={{ color: "rgba(255,255,255,0.7)" }}>
                {snapshot?.ask && snapshot?.bid && parseFloat(snapshot.ask) > 0 && parseFloat(snapshot.bid) > 0
                  ? `$${(parseFloat(snapshot.ask) - parseFloat(snapshot.bid)).toFixed(2)}`
                  : "\u2014"}
              </div>
              <div className="tr-pm-lbl">SPREAD</div>
            </div>
          </div>
        </div>
      </div>

      {/* BODY */}
      <div className="tr-body tr-fu tr-d1">
        {/* CHART — full height left column */}
        <div className="tr-chart-area">
          <CandlestickChart
            fundingRate={fundingRate}
          />
        </div>

        {/* RIGHT COLUMN — order panel + tabs */}
        <div className="tr-order-panel">
          <div className="tr-order-panel-top">
            <OrderPanel
              pair={selectedPair}
              position={currentPosition}
              quoteBalance={quoteBalance}
              onOrderFilled={refreshPositions}
            />
          </div>

          <div className="tr-order-panel-activity">
            <div className="tr-tab-bar">
              {TABS.map((t) => (
                <div
                  key={t}
                  className={`tr-tab${tab === t ? " active" : ""}`}
                  onClick={() => setTab(t)}
                >
                  {t}
                </div>
              ))}
            </div>
            <div className="tr-tab-content">
              {/* ── ORDERS ── */}
              {tab === "ORDERS" &&
                (openOrders.length === 0 ? (
                  <div className="tr-empty-state">
                    <div className="tr-es-lbl">No open orders</div>
                    <div className="tr-es-cta">{"\u25B8"} USE THE ORDER PANEL TO BEGIN</div>
                  </div>
                ) : (
                  <table className="tr-ptbl">
                    <thead>
                      <tr>
                        <th>SIDE</th>
                        <th>TYPE</th>
                        <th>QTY</th>
                        <th>PRICE</th>
                        <th>ACTION</th>
                      </tr>
                    </thead>
                    <tbody>
                      {openOrders.map((o) => {
                        const st = actionStates[o.id] ?? "idle";
                        const canCancel = (o.status === "OPEN" || o.status === "PARTIALLY_FILLED") && o.type === "LIMIT";
                        const canClose = o.status === "OPEN" && o.type === "MARKET";
                        const closeLabel = o.side === "BUY" ? "CLOSE LONG" : "CLOSE SHORT";

                        const handleCancel = async () => {
                          setActionStates((s) => ({ ...s, [o.id]: "loading" }));
                          try {
                            await cancelOrder(o.id);
                            setActionStates((s) => ({ ...s, [o.id]: "idle" }));
                          } catch {
                            setActionStates((s) => ({ ...s, [o.id]: "error" }));
                            setTimeout(() => setActionStates((s) => ({ ...s, [o.id]: "idle" })), 2000);
                          }
                        };

                        const handleClose = async () => {
                          if (!selectedPairId) return;
                          setActionStates((s) => ({ ...s, [o.id]: "loading" }));
                          try {
                            const closeSide = o.side === "BUY" ? "SELL" : "BUY";
                            const pos = positions.find((p) => p.pair_id === o.pair_id);
                            const closeQty = pos ? Math.abs(parseFloat(pos.base_qty)).toFixed(8) : o.qty;
                            await placeOrder(
                              { pairId: o.pair_id, side: closeSide, type: "MARKET", qty: closeQty },
                              crypto.randomUUID(),
                            );
                            refreshPositions();
                            setActionStates((s) => ({ ...s, [o.id]: "idle" }));
                          } catch {
                            setActionStates((s) => ({ ...s, [o.id]: "error" }));
                            setTimeout(() => setActionStates((s) => ({ ...s, [o.id]: "idle" })), 2000);
                          }
                        };

                        return (
                          <tr key={o.id}>
                            <td>
                              <span className={o.side === "BUY" ? "tr-side-b" : "tr-side-s"}>
                                {o.side}
                              </span>
                            </td>
                            <td>{o.type}</td>
                            <td>{o.qty}</td>
                            <td>{o.limit_price ?? "MKT"}</td>
                            <td>
                              {canCancel && (
                                <button
                                  className="tr-action-btn cancel"
                                  disabled={st === "loading"}
                                  onClick={handleCancel}
                                >
                                  {st === "loading" ? "..." : st === "error" ? "FAILED" : "\u2715 CANCEL"}
                                </button>
                              )}
                              {canClose && (
                                <button
                                  className="tr-action-btn close"
                                  disabled={st === "loading"}
                                  onClick={handleClose}
                                >
                                  {st === "loading" ? "..." : st === "error" ? "FAILED" : closeLabel}
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ))}

              {/* ── HISTORY ── */}
              {tab === "HISTORY" &&
                (historyTrades.length === 0 ? (
                  <div className="tr-empty-state">
                    <div className="tr-es-lbl">No trade history</div>
                    <div className="tr-es-cta">{"\u25B8"} CLOSED TRADES WILL APPEAR HERE</div>
                  </div>
                ) : (
                  <table className="tr-ptbl">
                    <thead>
                      <tr>
                        <th>PAIR</th>
                        <th>SIDE</th>
                        <th>ENTRY</th>
                        <th>EXIT</th>
                        <th>PNL</th>
                        <th>TIME</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyTrades.map((t: any, i: number) => {
                        const pnl = parseFloat(t.net_pnl ?? "0");
                        return (
                          <tr key={t.id ?? i}>
                            <td>
                              <span className="tr-sym">{t.pair_symbol ?? "?"}</span>
                            </td>
                            <td>
                              <span className={t.direction === "LONG" ? "tr-side-b" : "tr-side-s"}>
                                {t.direction}
                              </span>
                            </td>
                            <td>{formatUsd(t.entry_avg_price)}</td>
                            <td>{formatUsd(t.exit_avg_price)}</td>
                            <td className={pnl >= 0 ? "tr-pos" : "tr-neg"}>
                              {(pnl >= 0 ? "+" : "") + formatUsd(String(pnl.toFixed(2)))}
                            </td>
                            <td className="tr-dim">
                              {t.exit_at
                                ? new Date(t.exit_at).toLocaleDateString([], { month: "short", day: "numeric" })
                                : "\u2014"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ))}
            </div>
          </div>

          <div className="tr-order-panel-book">
            <OrderBookPanel liveBook={liveOrderBook} />
          </div>
        </div>
      </div>

      {/* ── Competition bottom bar ── */}
      {isInCompetition && activeMatch && (() => {
        const isChallenger = activeMatch.challenger_id === userId;
        const yourPnl = isChallenger ? activeMatch.challenger_pnl_pct : activeMatch.opponent_pnl_pct;
        const oppPnl = isChallenger ? activeMatch.opponent_pnl_pct : activeMatch.challenger_pnl_pct;
        const oppName = isChallenger ? (activeMatch.opponent_name ?? "OPPONENT") : (activeMatch.challenger_name ?? "OPPONENT");
        const endsAt = activeMatch.ends_at ? new Date(activeMatch.ends_at) : null;
        const now = new Date();
        const msLeft = endsAt ? Math.max(0, endsAt.getTime() - now.getTime()) : 0;
        const hrsLeft = Math.floor(msLeft / 3_600_000);
        const minsLeft = Math.floor((msLeft % 3_600_000) / 60_000);
        const timeStr = hrsLeft >= 24 ? `${Math.floor(hrsLeft / 24)}D ${hrsLeft % 24}H` : `${hrsLeft}H ${minsLeft}M`;
        const yPnl = parseFloat(yourPnl ?? "0");
        const oPnl = parseFloat(oppPnl ?? "0");
        return (
          <div style={{
            position: "absolute", bottom: 36, left: 0, right: 0, zIndex: 90,
            height: 32, display: "flex", alignItems: "center", gap: 24,
            padding: "0 16px", fontFamily: "'Space Mono', monospace",
            fontSize: 10, letterSpacing: 2, color: "#FF6B00",
            background: "rgba(255,107,0,0.06)", borderTop: "1px solid rgba(255,107,0,0.25)",
          }}>
            <span style={{ color: "#FF6B00", fontWeight: 700 }}>⚔ 1V1</span>
            <span>YOU: <span style={{ color: yPnl >= 0 ? "#00ff41" : "#ff3b3b" }}>{yPnl >= 0 ? "+" : ""}{yPnl.toFixed(2)}%</span></span>
            <span>{oppName.toUpperCase()}: <span style={{ color: oPnl >= 0 ? "#00ff41" : "#ff3b3b" }}>{oPnl >= 0 ? "+" : ""}{oPnl.toFixed(2)}%</span></span>
            <span style={{ marginLeft: "auto", color: "rgba(255,107,0,0.6)" }}>TIME: {timeStr}</span>
          </div>
        );
      })()}

      {/* Ticker is provided by AppLayout's <TickerBar /> */}
    </div>
  );
}
