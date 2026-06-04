import { useState, useEffect, useRef } from "react";
import Decimal from "decimal.js-light";
import { useAppStore } from "@/stores/appStore";
import { useAuthStore } from "@/stores/authStore";
import { useTradingStore } from "@/stores/tradingStore";
import { usePairPricesStore } from "@/stores/pairPricesStore";
import { useDailyOpenStore } from "@/stores/dailyOpenStore";
import { CandlestickChart } from "@/components/trading/CandlestickChart";
import AssetTab from "@/components/trading/AssetTab";
import { getPositions } from "@/api/endpoints/analytics";
import { getCandles } from "@/api/endpoints/candles";
import { getMsUntilNextUTCMidnight, dayDirection } from "@/lib/priceChange";
import { usePairChange } from "@/hooks/usePairChange";
import { isRealPair } from "@/lib/pairs";
import { useCompetitionMode } from "@/hooks/useCompetitionMode";
import client from "@/api/client";
import { UnifiedOrderPanel } from "@/components/trading/UnifiedOrderPanel";
import OrderDock from "@/components/trading/OrderDock";
import type { Position, OrderBook as OrderBookType, TradingPair } from "@/types/api";

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
  .tr-asset-tab .tr-at-chg { font-size:10px;letter-spacing:0.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .tr-asset-tab .up { color:var(--g); }
  .tr-asset-tab .dn { color:var(--red); }

  .tr-price-hero {
    margin-left:auto;display:flex;align-items:baseline;gap:10px;
  }
  .tr-price-big {
    font-family:var(--bebas);font-size:28px;color:#fff;
    letter-spacing:2px;line-height:1;
    transition:filter 0.15s ease-out, text-shadow 0.15s ease-out;
  }
  .tr-price-big.up { color:var(--g);text-shadow:0 0 20px var(--g25); }
  .tr-price-big.dn { color:var(--red); }
  .tr-price-big.down { color:var(--red);text-shadow:0 0 20px var(--red25); }
  .tr-price-big.flat { color:#fff; }
  /* Tick flash — a brief brightness+glow pulse layered ON TOP of the day color
     (sets filter/text-shadow only, never color). Listed after the day classes
     so its shadow wins for the ~150ms the class is present, then transitions
     back. The day color (red/green/white) is preserved throughout. */
  .tr-price-big.tick-up,
  .tr-price-big.tick-down {
    filter:brightness(1.6);
    text-shadow:0 0 26px rgba(255,255,255,0.6);
  }
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
    grid-template-columns:1fr 360px;
    grid-template-rows:1fr;
    grid-template-areas: "chart order";
    overflow:hidden;min-height:0;
    /* Flex-fill the height left in .tr-wrap (asset bar + body + order dock).
       Was a hardcoded calc(100vh - 126px); the bottom OrderDock needs the body
       to flex so the two share height without overflow. .tr-wrap has a definite
       height from AppLayout (h-screen → main flex-1), so flex:1 resolves; the
       chart's ResizeObserver re-fits when the dock expands/collapses. */
    flex:1 1 0;
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
  .tr-ob { display:grid;grid-template-columns:1.6fr 1fr;gap:0;height:100%; }
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

  /* ── ORDER DOCK (full-width, bottom of .tr-wrap, above AppLayout ticker) ── */
  .tr-order-dock {
    flex-shrink:0;display:flex;flex-direction:column;
    border-top:1px solid var(--border);background:rgba(5,5,5,0.97);overflow:hidden;
  }
  .tr-order-dock.collapsed { height:30px; }
  .tr-order-dock.expanded { height:210px; }
  /* whole bar is the toggle target (role=button); tabs + chevron are spans */
  .tr-dock-bar {
    height:30px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;
    padding:0 14px;border-bottom:1px solid var(--borderW);
    cursor:pointer;user-select:none;
  }
  .tr-dock-bar[aria-disabled="true"] { cursor:default; }
  .tr-dock-tabs { display:flex;gap:14px;align-items:center; }
  .tr-dock-tab {
    font-family:var(--mono);font-size:9px;letter-spacing:2px;text-transform:uppercase;
    color:rgba(255,255,255,0.4);display:flex;align-items:center;gap:6px;
  }
  .tr-dock-tab.active { color:var(--text); }
  .tr-dock-count {
    font-family:var(--mono);font-size:9px;letter-spacing:1px;color:var(--g);
    border:1px solid rgba(0,255,65,0.3);padding:0 4px;line-height:14px;
  }
  .tr-dock-toggle {
    color:rgba(255,255,255,0.4);font-size:11px;line-height:1;padding:2px 4px;
  }
  .tr-dock-bar:hover:not([aria-disabled="true"]) .tr-dock-toggle,
  .tr-dock-bar:hover:not([aria-disabled="true"]) .tr-dock-tab.active { color:var(--text); }
  .tr-dock-bar[aria-disabled="true"] .tr-dock-toggle { opacity:0.35; }
  .tr-dock-content { flex:1;min-height:0;overflow-y:auto; }
  .tr-dock-content::-webkit-scrollbar { width:2px; }
  .tr-dock-content::-webkit-scrollbar-thumb { background:var(--border); }

  /* open-orders table — builds on .tr-ptbl */
  .tr-ptbl th.tr-oo-num, .tr-ptbl td.tr-oo-num { text-align:right;font-family:var(--mono); }
  .tr-ptbl th.tr-oo-act, .tr-ptbl td.tr-oo-act { text-align:right; }
  .tr-oo-fill { display:flex;align-items:center;justify-content:flex-end;gap:6px; }
  .tr-oo-bar { width:34px;height:4px;border-radius:2px;background:rgba(255,255,255,0.1);overflow:hidden; }
  .tr-oo-bar-f { height:100%;border-radius:2px; }
  .tr-oo-bar-f.buy { background:var(--g); }
  .tr-oo-bar-f.sell { background:var(--red); }
  .tr-oo-cancel {
    background:none;border:1px solid var(--borderW);cursor:pointer;
    font-family:var(--mono);font-size:9px;letter-spacing:1px;text-transform:uppercase;
    color:rgba(255,255,255,0.5);padding:2px 9px;
  }
  .tr-oo-cancel:hover:not(:disabled) { color:var(--red);border-color:rgba(255,59,59,0.4); }
  .tr-oo-cancel:disabled { opacity:0.5;cursor:default; }

  /* ── ORDER PANEL ── */
  .tr-order-panel {
    grid-area:order;
    background:rgba(5,5,5,0.97);
    display:flex;flex-direction:column;
    border-left:1px solid var(--border);
    height:100%;max-height:100%;overflow:hidden;
  }
  .tr-order-panel-top {
    flex:1 1 0;overflow-y:auto;min-height:0;
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
    flex:0 0 150px;max-height:150px;overflow-y:auto;
    border-top:1px solid var(--border);
    padding-top:0;
  }

  /* shared UnifiedOrderPanel root (classPrefix "tr") — padding matches the
     arena's .lmv-order-section so both consumers of the component align */
  .tr-order-section {
    padding:12px 16px;
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

  /* Order-form sticky submit footer. Base is layout-transparent (display:contents)
     so the has-position case is unchanged; when there is NO open position the
     -pinned variant pins the cost summary + submit to the bottom of the scrollable
     .tr-order-panel-top, so OPEN LONG/SHORT is always reachable regardless of scroll
     or how tall the OrderDock is. Edge-to-edge + opaque (mirrors the position card),
     z-index below the card (1 < 2) so the card wins when both could be present. */
  .tr-order-footer { display:contents; }
  .tr-order-footer-pinned {
    display:block;position:sticky;bottom:0;z-index:1;
    margin:0 -16px;padding:8px 16px 10px;
    /* fully opaque (matches the position card's #050505) so scrolling form
       fields — e.g. the TRAILING STOP label — can't bleed through behind the
       summary rows. Opaque color rather than relying on z-index. */
    background:#050505;border-top:1px solid var(--borderW);
  }

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
  .tr-dir-toggle { display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--borderW); }
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

  /* sticky position card — pins to the bottom of the scrollable order panel
     area (.tr-order-panel-top) so an open position stays visible regardless
     of scroll. Negative horizontal margin cancels .tr-order-section padding
     for an edge-to-edge bar; the opaque background covers form content
     scrolling behind it; the top border separates it from that content. */
  .tr-position-card-sticky {
    position:sticky;bottom:0;z-index:2;
    margin:12px -16px 0;padding:12px 16px;
    background:#050505;
    border-top:1px solid rgba(255,255,255,0.08);
  }

  /* ticker provided by AppLayout */
`;

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

/**
 * Fetch each pair's daily OPEN (a single 1d candle) and cache it in
 * dailyOpenStore. The 24h change is then derived live in <AssetTab> from the
 * SSE-driven price + this cached open, instead of polling /candles per render.
 *
 * Module-scoped — no component-scope deps. `isCancelled` lets the caller abort
 * an in-flight sweep (effect cleanup). Errors are swallowed per pair: a missing
 * open just leaves usePairChange returning null (chip shows no change).
 */
async function fetchAllOpensInto(
  pairsToFetch: TradingPair[],
  isCancelled: () => boolean,
): Promise<void> {
  for (const pair of pairsToFetch) {
    if (isCancelled()) return;
    try {
      const res = await getCandles(pair.id, { timeframe: "1d", limit: 1 });
      if (isCancelled()) return;
      const open = res.data.candles?.[0]?.open; // axios response; open is a string
      if (open !== undefined) {
        useDailyOpenStore.getState().setDailyOpen(pair.id, parseFloat(open));
      }
    } catch {
      // Swallow — chip shows no change until the next refetch attempt.
    }
  }
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
  const selectedPairPrice = usePairPricesStore((s) =>
    selectedPairId ? s.prices[selectedPairId] : undefined,
  );
  const [positions, setPositions] = useState<Position[]>([]);
  // Deribit's hourly-applied funding rate (current_funding). null = not yet
  // fetched (renders em-dash). A fetched value of 0 is a genuine, meaningful
  // funding rate and renders as "0.0000%".
  const [fundingRateHourly, setFundingRateHourly] = useState<number | null>(null);

  // Hero-price PERSISTENT color tracks the DAY (open→now, same source as the
  // chip), derived below from usePairChange. The tick-to-tick movement is now a
  // brief FLASH layered on top, not a persistent color: prevPriceRef holds the
  // last seen price; a non-flat tick toggles a transient class for ~150ms.
  const prevPriceRef = useRef<number | null>(null);
  const [tickFlash, setTickFlash] = useState<"" | "tick-up" | "tick-down">("");
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

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

  // Fetch funding rate from basis endpoint. We display fundingRateHourly
  // (Deribit current_funding) — the rate actually applied each hour — to
  // pair honestly with the Market Context Bar's hourly countdown.
  useEffect(() => {
    const fetchFunding = async () => {
      try {
        const res = await client.get<{
          ok: boolean;
          fundingRateHourly: number;
          fundingRate8h: number;
        }>("/market/basis");
        setFundingRateHourly(res.data.fundingRateHourly ?? 0);
      } catch { /* non-fatal */ }
    };
    fetchFunding();
    const interval = setInterval(fetchFunding, 60_000);
    return () => clearInterval(interval);
  }, []);

  // API only returns active pairs (WHERE is_active = true), no need to re-filter
  const activePairs = pairs;
  const selectedPair = pairs.find((p) => p.id === selectedPairId);

  // 24h price-change derivation: fetch each pair's daily OPEN once into
  // dailyOpenStore; the change is then computed live in <AssetTab> from
  // SSE price + cached open via usePairChange. Naturally idempotent —
  // refetches only pairs not yet in the store, so safe under React
  // StrictMode's double-invocation in dev and robust to pairs added later.
  useEffect(() => {
    const active = pairs.filter(isRealPair);
    if (!active.length) return; // pairs not loaded yet; effect re-runs when they arrive
    const cached = useDailyOpenStore.getState().opens;
    const missing = active.filter((p) => !cached[p.id]);
    if (!missing.length) return; // all opens already cached
    let cancelled = false;
    fetchAllOpensInto(missing, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [pairs]);

  // Refetch daily opens at each UTC midnight (the open rolls over). Independent
  // mount-only effect — reads pairs fresh from the store each tick, recomputes
  // the next midnight from `now` so it can't drift.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function schedule() {
      timer = setTimeout(() => {
        fetchAllOpensInto(useAppStore.getState().pairs.filter(isRealPair), () => false);
        schedule();
      }, getMsUntilNextUTCMidnight());
    }
    schedule();
    return () => clearTimeout(timer);
  }, []);

  // Current price: prefer SSE snapshot, fall back to the cached pair price.
  // snapshot-first is load-bearing for replay mode (onReplayTick writes
  // snapshot but NOT pairPricesStore); do not collapse to selectedPairPrice.
  const currentPrice = snapshot?.last
    ? parseFloat(snapshot.last)
    : selectedPairPrice ?? 0;

  // Persistent hero color = the DAY (open→now), from the same source as the
  // chip's %: usePairChange (SSE price vs cached daily open). dayChange is null
  // until the open is cached / a price has ticked.
  const dayChange = usePairChange(selectedPairId ?? "");
  // Hold the last known day-direction across transient null windows (the price
  // store retains the last tick, so disconnect alone won't null this — but a
  // momentary missing open shouldn't flash neutral). Reset synchronously on
  // pair switch so no stale color carries to the new asset (React's
  // derive-state-during-render reset pattern, runs before the first paint of
  // the new pair).
  const lastDayDirRef = useRef<"up" | "down" | "flat">("flat");
  const lastPairForDirRef = useRef<string | null>(selectedPairId);
  if (lastPairForDirRef.current !== selectedPairId) {
    lastPairForDirRef.current = selectedPairId;
    lastDayDirRef.current = "flat";
  }
  const dayDir =
    dayChange === null ? lastDayDirRef.current : dayDirection(dayChange);
  lastDayDirRef.current = dayDir;

  // Quote wallet balance (USD)
  const quoteAssetId = selectedPair?.quote_asset_id;
  const quoteWallet = wallets.find((w) => w.asset_id === quoteAssetId);
  const quoteBalance = quoteWallet
    ? new Decimal(quoteWallet.balance).minus(quoteWallet.reserved ?? "0").toNumber()
    : 0;

  // Position for selected pair
  const currentPosition = positions.find((p) => p.pair_id === selectedPairId) ?? null;

  // Reset tick-flash tracking when switching pairs — comparing one asset's
  // price against another's would produce a bogus flash.
  useEffect(() => {
    prevPriceRef.current = null;
    clearTimeout(flashTimerRef.current);
    setTickFlash("");
  }, [selectedPairId]);

  // Tick FLASH: a brief pulse on real movement between ticks, layered on top of
  // the persistent day color (does not repaint it). Toggles a transient class
  // for ~150ms, then clears.
  useEffect(() => {
    if (!currentPrice) return; // no price / disconnect
    const prev = prevPriceRef.current;
    prevPriceRef.current = currentPrice;
    if (prev === null) return; // first tick for this pair — no flash
    if (currentPrice === prev) return; // flat tick — nothing to flash
    setTickFlash(currentPrice > prev ? "tick-up" : "tick-down");
    clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setTickFlash(""), 150);
  }, [currentPrice]);

  // Clear any pending flash timer on unmount.
  useEffect(() => () => clearTimeout(flashTimerRef.current), []);

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
          {activePairs.slice(0, 6).map((p) => (
            <AssetTab
              key={p.id}
              pairId={p.id}
              symbol={p.symbol}
              isActive={p.id === selectedPairId}
            />
          ))}
        </div>

        <div className="tr-price-hero">
          <span className={`tr-price-big ${dayDir} ${tickFlash}`}>
            ${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </span>
          {/* Funding rate relocated to the Market Context Bar (chart row).
              Spread stays here. */}
          <div className="tr-price-meta">
            <div className="tr-pm-item">
              <div className="tr-pm-val" style={{ color: "rgba(255,255,255,0.7)" }}>
                {(() => {
                  const ask = snapshot?.ask ? parseFloat(snapshot.ask) : 0;
                  const bid = snapshot?.bid ? parseFloat(snapshot.bid) : 0;
                  // Collapse to em-dash only when bid/ask are genuinely absent
                  // or non-positive. A zero spread (bid === ask) is a real
                  // market state and still renders "$0.00 (0.000%)".
                  if (!(ask > 0) || !(bid > 0)) return "\u2014";
                  const spreadDollars = ask - bid;
                  const midPrice = (ask + bid) / 2;
                  if (midPrice === 0) return "\u2014";
                  const spreadPct = (spreadDollars / midPrice) * 100;
                  return `$${spreadDollars.toFixed(2)} (${spreadPct.toFixed(3)}%)`;
                })()}
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
            fundingRateHourly={fundingRateHourly}
          />
        </div>

        {/* RIGHT COLUMN — order panel + tabs */}
        <div className="tr-order-panel">
          <div className="tr-order-panel-top">
            <UnifiedOrderPanel
              pair={selectedPair}
              position={currentPosition}
              quoteBalance={quoteBalance}
              onOrderFilled={refreshPositions}
              classPrefix="tr"
            />
          </div>

          {/* Open orders now live in the full-width OrderDock below the body
              (this was a right-panel tab slot before). */}

          <div className="tr-order-panel-book">
            <OrderBookPanel liveBook={liveOrderBook} />
          </div>
        </div>
      </div>

      {/* OPEN-ORDERS DOCK — full width, between the chart row and AppLayout's ticker */}
      <OrderDock />

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
