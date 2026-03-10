import { useState, useEffect, useCallback } from "react";
import type { TradeSetup } from "@/lib/confluenceEngine";
import Decimal from "decimal.js-light";
import { useAppStore } from "@/stores/appStore";
import { useTradingStore } from "@/stores/tradingStore";
import { CandlestickChart } from "@/components/trading/CandlestickChart";
import { getPositions } from "@/api/endpoints/analytics";
import { getDerivatives } from "@/api/endpoints/signals";
import { formatDecimal, formatUsd } from "@/lib/decimal";
import type { Position, TradingPair, OrderBook as OrderBookType } from "@/types/api";
import type { AxiosError } from "axios";
import type { V1ApiError } from "@/types/api";

/* ─────────────────────────────────────────
   TRADE PAGE CSS — Circuit Noir
───────────────────────────────────────── */
const TRADE_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap');

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
    display:flex;align-items:center;gap:0;
    border-bottom:1px solid var(--border);
    background:rgba(4,4,4,0.97);flex-shrink:0;
    height:46px;padding:0 16px;
  }
  .tr-asset-tab {
    display:flex;align-items:center;gap:8px;
    padding:0 20px;height:100%;font-size:11px;letter-spacing:3px;
    color:var(--muted);text-transform:uppercase;cursor:pointer;
    border-right:1px solid var(--borderW);
    transition:all 0.15s;position:relative;
    border-bottom:2px solid transparent;
  }
  .tr-asset-tab:hover { color:#fff;background:var(--g06); }
  .tr-asset-tab.active {
    color:var(--g);background:var(--g06);
    border-bottom-color:var(--g);
  }
  .tr-asset-tab .tr-at-price {
    font-family:var(--bebas);font-size:16px;color:#fff;letter-spacing:1px;
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
    grid-template-rows:1fr auto;
    grid-template-areas:
      "chart order"
      "tabs  order";
    overflow:hidden;min-height:0;
    /* explicit height: viewport minus topbar(~41px) + p-1.5 padding(3px) + asset-bar(46px) + ticker(36px) */
    height: calc(100vh - 126px);
  }

  /* ── CHART AREA ── */
  .tr-chart-area {
    grid-area:chart;
    display:flex;flex-direction:column;
    border-right:1px solid var(--border);
    overflow:hidden;
    height:100%;
    min-height:0;
  }
  /* chart area uses CandlestickChart component (Lightweight Charts) */

  /* ── TABS PANEL (below chart) ── */
  .tr-tabs-area {
    grid-area:tabs;
    border-right:1px solid var(--border);
    display:flex;flex-direction:column;
    max-height:240px;overflow:hidden;
  }
  .tr-tab-bar {
    display:flex;border-bottom:1px solid var(--borderW);
    background:rgba(5,5,5,0.9);flex-shrink:0;
  }
  .tr-tab {
    padding:9px 16px;font-size:8px;letter-spacing:3px;
    color:var(--muted);text-transform:uppercase;cursor:pointer;
    border-bottom:2px solid transparent;transition:all 0.15s;
  }
  .tr-tab:hover { color:#fff;background:var(--g06); }
  .tr-tab.active { color:var(--g);border-bottom-color:var(--g); }

  .tr-tab-content { flex:1;overflow-y:auto; }
  .tr-tab-content::-webkit-scrollbar { width:2px; }
  .tr-tab-content::-webkit-scrollbar-thumb { background:var(--border); }

  /* order book */
  .tr-ob { display:grid;grid-template-columns:1fr 1fr;gap:0;height:100%; }
  .tr-ob-col { overflow:hidden; }
  .tr-ob-col:first-child { border-right:1px solid var(--borderW); }
  .tr-ob-hdr {
    display:grid;grid-template-columns:1fr 1fr 1fr;
    padding:6px 12px;border-bottom:1px solid var(--borderW);
    font-size:7px;color:rgba(255,255,255,0.18);letter-spacing:3px;
    text-transform:uppercase;
  }
  .tr-ob-hdr span:last-child { text-align:right; }
  .tr-ob-row {
    display:grid;grid-template-columns:1fr 1fr 1fr;
    padding:4px 12px;font-size:9px;position:relative;
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
  .tr-ob-row.ask span:first-child { color:var(--red); }
  .tr-ob-row.bid span:first-child { color:var(--g); }
  .tr-ob-row span:last-child { text-align:right;color:rgba(255,255,255,0.4); }
  .tr-ob-spread {
    padding:4px 12px;text-align:center;font-size:8px;
    color:rgba(255,255,255,0.25);letter-spacing:2px;
    border-top:1px solid var(--borderW);border-bottom:1px solid var(--borderW);
    background:rgba(0,0,0,0.3);
  }

  /* positions / orders table */
  .tr-ptbl { width:100%;border-collapse:collapse; }
  .tr-ptbl th {
    font-size:7px;color:rgba(255,255,255,0.18);letter-spacing:3px;
    text-transform:uppercase;padding:8px 16px;
    border-bottom:1px solid var(--borderW);text-align:left;font-weight:400;
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
    padding:24px;gap:6px;
  }
  .tr-es-lbl { font-size:8px;color:rgba(255,255,255,0.13);letter-spacing:4px;text-transform:uppercase; }
  .tr-es-cta { font-size:8px;color:rgba(0,255,65,0.3);letter-spacing:3px;margin-top:3px; }

  /* ── ORDER PANEL ── */
  .tr-order-panel {
    grid-area:order;grid-row:1/-1;
    background:rgba(5,5,5,0.97);
    display:flex;flex-direction:column;overflow-y:auto;
    border-left:1px solid var(--border);
  }
  .tr-order-panel::-webkit-scrollbar { width:2px; }
  .tr-order-panel::-webkit-scrollbar-thumb { background:var(--border); }

  .tr-op-section {
    padding:14px 16px;border-bottom:1px solid var(--borderW);
  }
  .tr-op-title {
    font-size:7px;color:rgba(255,255,255,0.2);letter-spacing:5px;
    text-transform:uppercase;margin-bottom:12px;
    display:flex;align-items:center;gap:7px;
  }
  .tr-op-title::before { content:'\\25CC';color:var(--g);font-size:10px; }

  /* side toggle BUY/SELL */
  .tr-side-toggle { display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--borderW); }
  .tr-st-buy,.tr-st-sell {
    padding:12px;text-align:center;font-family:var(--bebas);
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
  .tr-type-toggle { display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px; }
  .tr-tt {
    padding:7px;text-align:center;font-size:9px;letter-spacing:3px;
    color:var(--muted);border:1px solid var(--borderW);transition:all 0.15s;cursor:pointer;
  }
  .tr-tt.active { color:var(--g);border-color:var(--border);background:var(--g06); }
  .tr-tt:not(.active):hover { color:#fff;background:var(--faint); }

  /* input fields */
  .tr-field { margin-top:10px; }
  .tr-field-lbl {
    font-size:7px;color:rgba(255,255,255,0.22);letter-spacing:4px;
    text-transform:uppercase;margin-bottom:6px;display:block;
  }
  .tr-field-wrap {
    display:flex;align-items:center;
    border:1px solid var(--borderW);background:rgba(0,0,0,0.4);
    transition:border-color 0.2s;
    clip-path:polygon(5px 0%,100% 0%,calc(100% - 5px) 100%,0% 100%);
  }
  .tr-field-wrap:focus-within { border-color:var(--g50);box-shadow:0 0 12px rgba(0,255,65,0.06); }
  .tr-field-wrap input {
    flex:1;background:transparent;border:none;outline:none;
    font-family:var(--mono);font-size:12px;color:#fff;
    padding:10px 12px;letter-spacing:1px;
  }
  .tr-field-wrap input::placeholder { color:rgba(255,255,255,0.15); }
  .tr-field-unit {
    font-size:8px;color:var(--muted);letter-spacing:2px;
    padding:0 12px;border-left:1px solid var(--borderW);flex-shrink:0;
  }

  /* pct buttons */
  .tr-pct-row { display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:8px; }
  .tr-pct {
    padding:5px 0;text-align:center;font-size:8px;letter-spacing:1px;
    color:var(--muted);border:1px solid var(--borderW);transition:all 0.15s;cursor:pointer;
  }
  .tr-pct:hover { color:var(--g);border-color:var(--border);background:var(--g06); }
  .tr-pct.active { color:var(--g);border-color:var(--g);background:var(--g06); }

  /* order summary */
  .tr-summary { margin-top:12px;border-top:1px solid var(--borderW);padding-top:12px; }
  .tr-sum-row {
    display:flex;justify-content:space-between;
    font-size:9px;padding:3px 0;
  }
  .tr-sum-lbl { color:rgba(255,255,255,0.2);letter-spacing:2px; }
  .tr-sum-val { color:rgba(255,255,255,0.5); }

  /* place order button */
  .tr-place-btn {
    width:100%;padding:14px;border:none;margin-top:14px;
    font-family:var(--mono);font-size:11px;font-weight:700;
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
    padding:10px 16px;border-top:1px solid var(--borderW);
    font-size:8px;
  }
  .tr-bal-lbl { color:rgba(255,255,255,0.18);letter-spacing:2px; }
  .tr-bal-val { color:rgba(255,255,255,0.55);letter-spacing:1px; }
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
    padding:8px 12px;border-bottom:1px solid var(--faint);
    font-size:9px;
  }
  .tr-pos-row:last-child { border-bottom:none; }
  .tr-pos-key { color:rgba(255,255,255,0.22);letter-spacing:2px; }
  .tr-pos-val { color:rgba(255,255,255,0.6); }

  /* animations */
  @keyframes tr-fadeup { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
  .tr-fu { animation:tr-fadeup 0.35s ease both; }
  .tr-d1{animation-delay:0.04s} .tr-d2{animation-delay:0.08s}
  .tr-d3{animation-delay:0.13s} .tr-d4{animation-delay:0.18s}

  /* ticker provided by AppLayout */
`;

/* ── STATIC DATA ── */
const TABS = ["ORDER BOOK", "POSITIONS", "ORDERS", "TRADES"];

const ERROR_MAP: Record<string, string> = {
  insufficient_balance: "Insufficient balance",
  risk_check_failed: "Risk check failed",
  governance_check_failed: "Governance check failed",
  quota_exceeded: "Order limit exceeded",
  pair_queue_overloaded: "Queue full, retry shortly",
  trading_paused_global: "Trading is paused",
  trading_paused_pair: "Trading is paused for this pair",
};

/* ── ORDER BOOK DATA (generated fallback) ── */
interface BookRow {
  price: string;
  qty: string;
  total: string;
}

function genBook(mid: number): { asks: BookRow[]; bids: BookRow[] } {
  const asks: BookRow[] = [];
  const bids: BookRow[] = [];
  for (let i = 0; i < 8; i++) {
    const p = mid + (i + 1) * mid * 0.0003;
    asks.push({
      price: p.toFixed(2),
      qty: (Math.random() * 2 + 0.1).toFixed(4),
      total: (p * (Math.random() * 2 + 0.1)).toFixed(2),
    });
  }
  for (let i = 0; i < 8; i++) {
    const p = mid - (i + 1) * mid * 0.0003;
    bids.push({
      price: p.toFixed(2),
      qty: (Math.random() * 2 + 0.1).toFixed(4),
      total: (p * (Math.random() * 2 + 0.1)).toFixed(2),
    });
  }
  return { asks: asks.reverse(), bids };
}

/* ── ORDER BOOK ── */
function OrderBookPanel({
  pair,
  liveBook,
}: {
  pair: TradingPair;
  liveBook: OrderBookType | null;
}) {
  const midPrice = pair.last_price ? parseFloat(pair.last_price) : 0;

  // Use real order book if available, else generated fallback
  const book = (() => {
    if (liveBook && liveBook.asks.length > 0 && liveBook.bids.length > 0) {
      const asks = liveBook.asks.slice(0, 8).map((lvl) => ({
        price: parseFloat(lvl.price).toFixed(2),
        qty: parseFloat(lvl.qty).toFixed(4),
        total: (parseFloat(lvl.price) * parseFloat(lvl.qty)).toFixed(2),
      }));
      const bids = liveBook.bids.slice(0, 8).map((lvl) => ({
        price: parseFloat(lvl.price).toFixed(2),
        qty: parseFloat(lvl.qty).toFixed(4),
        total: (parseFloat(lvl.price) * parseFloat(lvl.qty)).toFixed(2),
      }));
      return { asks: asks.reverse(), bids };
    }
    if (midPrice > 0) return genBook(midPrice);
    return genBook(1000);
  })();

  // If no live book, refresh periodically with generated data
  const [, setTick] = useState(0);
  useEffect(() => {
    if (liveBook) return;
    const id = setInterval(() => setTick((t) => t + 1), 2000);
    return () => clearInterval(id);
  }, [liveBook]);

  const firstAskPrice = parseFloat(book.asks[book.asks.length - 1]?.price ?? "0");
  const firstBidPrice = parseFloat(book.bids[0]?.price ?? "0");
  const spread = (firstAskPrice - firstBidPrice).toFixed(2);
  const spreadPct = midPrice > 0 ? ((parseFloat(spread) / midPrice) * 100).toFixed(3) : "0.000";

  const firstBidQty = parseFloat(book.bids[0]?.qty ?? "0");
  const firstAskQty = parseFloat(book.asks[book.asks.length - 1]?.qty ?? "0");
  const totalQty = firstBidQty + firstAskQty || 1;

  return (
    <div className="tr-ob">
      <div className="tr-ob-col">
        <div className="tr-ob-hdr">
          <span>PRICE</span>
          <span>QTY</span>
          <span>TOTAL</span>
        </div>
        {book.asks.map((r, i) => (
          <div key={i} className="tr-ob-row ask">
            <div className="fill" style={{ width: `${Math.min(parseFloat(r.qty) * 40, 100)}%` }} />
            <span>{r.price}</span>
            <span className="tr-dim">{r.qty}</span>
            <span>{r.total}</span>
          </div>
        ))}
        <div className="tr-ob-spread">
          SPREAD {spread} ({spreadPct}%)
        </div>
        {book.bids.map((r, i) => (
          <div key={i} className="tr-ob-row bid">
            <div className="fill" style={{ width: `${Math.min(parseFloat(r.qty) * 40, 100)}%` }} />
            <span>{r.price}</span>
            <span className="tr-dim">{r.qty}</span>
            <span>{r.total}</span>
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
            {((firstBidQty * 100) / totalQty).toFixed(0)}%
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
            {((firstAskQty * 100) / totalQty).toFixed(0)}%
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
}: {
  pair: TradingPair;
  position: Position | null;
  quoteBalance: number;
}) {
  const orderSide = useTradingStore((s) => s.orderSide);
  const orderType = useTradingStore((s) => s.orderType);
  const qty = useTradingStore((s) => s.qty);
  const limitPrice = useTradingStore((s) => s.limitPrice);
  const orderSubmitting = useTradingStore((s) => s.orderSubmitting);
  const setOrderSide = useTradingStore((s) => s.setOrderSide);
  const setOrderType = useTradingStore((s) => s.setOrderType);
  const setQty = useTradingStore((s) => s.setQty);
  const setLimitPrice = useTradingStore((s) => s.setLimitPrice);
  const submitOrder = useTradingStore((s) => s.submitOrder);
  const snapshot = useTradingStore((s) => s.snapshot);

  const [pct, setPct] = useState<number | null>(null);
  const [btnState, setBtnState] = useState<"idle" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const [baseSymbol] = pair.symbol.split("/") as [string, string];
  const currentPrice = snapshot?.last ? parseFloat(snapshot.last) : (pair.last_price ? parseFloat(pair.last_price) : 0);

  const effectivePrice =
    orderType === "LIMIT" && limitPrice ? parseFloat(limitPrice) : currentPrice;

  const qtyNum = qty ? parseFloat(qty) : 0;
  const estTotal = qtyNum && effectivePrice ? (qtyNum * effectivePrice).toFixed(2) : null;
  const estFee = estTotal ? (parseFloat(estTotal) * (pair.taker_fee_bps / 10000)).toFixed(2) : null;

  const side = orderSide === "BUY" ? "buy" : "sell";
  const type = orderType === "MARKET" ? "market" : "limit";

  const handlePct = (p: number) => {
    setPct(p);
    if (currentPrice > 0) {
      const dollars = quoteBalance * (p / 100);
      setQty((dollars / currentPrice).toFixed(4));
    }
  };

  const handlePlaceOrder = async () => {
    setErrorMsg("");
    setBtnState("idle");
    try {
      await submitOrder();
      setBtnState("success");
      setPct(null);
      setTimeout(() => setBtnState("idle"), 2000);
    } catch (err) {
      const axErr = err as AxiosError<V1ApiError | { error: string }>;
      const data = axErr.response?.data;
      let msg = "FAILED \u2014 RETRY";
      if (data) {
        const code = "code" in data ? data.code : "error" in data ? data.error : "";
        const message = "message" in data ? data.message : "";
        msg = ERROR_MAP[code] ?? (typeof message === "string" && message ? message : "FAILED \u2014 RETRY");
      }
      setErrorMsg(msg);
      setBtnState("error");
      setTimeout(() => setBtnState("idle"), 3000);
    }
  };

  const btnLabel = (() => {
    if (orderSubmitting) return "PLACING...";
    if (btnState === "success") return "ORDER PLACED";
    if (btnState === "error") return errorMsg || "FAILED \u2014 RETRY";
    const arrow = side === "buy" ? "\u25B2" : "\u25BC";
    return `${arrow} PLACE ${type.toUpperCase()} ${side.toUpperCase()}`;
  })();

  const btnClass = (() => {
    if (btnState === "success") return "tr-place-btn success";
    if (btnState === "error") return "tr-place-btn error";
    return `tr-place-btn ${side}`;
  })();

  const pnlValue = position ? parseFloat(position.unrealized_pnl_quote) : 0;

  return (
    <div className="tr-order-panel">
      {/* SIDE TOGGLE */}
      <div className="tr-op-section" style={{ paddingBottom: 0 }}>
        <div className="tr-side-toggle">
          <div
            className={`tr-st-buy${orderSide === "BUY" ? " active" : ""}`}
            onClick={() => setOrderSide("BUY")}
          >
            BUY
          </div>
          <div
            className={`tr-st-sell${orderSide === "SELL" ? " active" : ""}`}
            onClick={() => setOrderSide("SELL")}
          >
            SELL
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
        <div className="tr-op-title">Order Details</div>

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
                ? parseFloat(limitPrice).toLocaleString()
                : "MARKET"}
            </span>
          </div>
          <div className="tr-sum-row">
            <span className="tr-sum-lbl">ESTIMATED</span>
            <span className="tr-sum-val">
              {estTotal ? parseFloat(estTotal).toLocaleString() : "--"}
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
                ? (parseFloat(estTotal) + parseFloat(estFee)).toLocaleString()
                : "--"}
            </span>
          </div>
        </div>

        {/* PLACE ORDER */}
        <button
          className={btnClass}
          disabled={orderSubmitting || !qty}
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
        <div className="tr-op-title">Open Position</div>
        <div className="tr-pos-card">
          <div className="tr-pos-row">
            <span className="tr-pos-key">SIZE</span>
            <span className="tr-pos-val" style={!position ? { color: "rgba(255,255,255,0.2)" } : undefined}>
              {position ? `${formatDecimal(position.base_qty, 8)} ${baseSymbol}` : "\u2014"}
            </span>
          </div>
          <div className="tr-pos-row">
            <span className="tr-pos-key">ENTRY</span>
            <span className="tr-pos-val" style={!position ? { color: "rgba(255,255,255,0.2)" } : undefined}>
              {position ? formatUsd(position.avg_entry_price) : "\u2014"}
            </span>
          </div>
          <div className="tr-pos-row">
            <span className="tr-pos-key">PNL</span>
            <span
              className="tr-pos-val"
              style={
                !position
                  ? { color: "rgba(255,255,255,0.2)" }
                  : { color: pnlValue >= 0 ? "var(--g)" : "var(--red)" }
              }
            >
              {position ? formatUsd(position.unrealized_pnl_quote) : "\u2014"}
            </span>
          </div>
          <div className="tr-pos-row" style={{ borderBottom: "none" }}>
            <span className="tr-pos-key">LIQ PRICE</span>
            <span className="tr-pos-val" style={{ color: "rgba(255,255,255,0.2)" }}>
              {"\u2014"}
            </span>
          </div>
        </div>
        {!position && (
          <div
            style={{
              textAlign: "center",
              padding: "10px 0 2px",
              fontSize: 8,
              color: "rgba(0,255,65,0.25)",
              letterSpacing: 3,
            }}
          >
            NO OPEN {baseSymbol} POSITION
          </div>
        )}
      </div>
    </div>
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

  const [tab, setTab] = useState("ORDER BOOK");
  const [positions, setPositions] = useState<Position[]>([]);
  const [fundingRate, setFundingRate] = useState(0);

  const handleTradeSetupChange = useCallback((_setup: TradeSetup | null) => {
    // trade setup state available if needed by bottom tabs
  }, []);

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
  useEffect(() => {
    let cancelled = false;
    getPositions()
      .then((res) => {
        if (!cancelled) setPositions(res.data.positions);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedPairId]);

  // Fetch funding rate for confluence engine
  useEffect(() => {
    if (!selectedPairId) return;
    const fetchFunding = async () => {
      try {
        const res = await getDerivatives(selectedPairId);
        setFundingRate(res.data.derivatives?.fundingRate ?? 0);
      } catch { /* non-fatal */ }
    };
    fetchFunding();
    const interval = setInterval(fetchFunding, 60_000);
    return () => clearInterval(interval);
  }, [selectedPairId]);

  const activePairs = pairs.filter((p) => p.is_active);
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
        {activePairs.slice(0, 6).map((p) => {
          const isActive = p.id === selectedPairId;
          const price = p.last_price ? parseFloat(p.last_price) : 0;
          return (
            <div
              key={p.id}
              className={`tr-asset-tab${isActive ? " active" : ""}`}
              onClick={() => selectPair(p.id)}
            >
              <span>{p.symbol}</span>
              <span className="tr-at-price">
                ${price.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
            </div>
          );
        })}

        <div className="tr-price-hero">
          <span className="tr-price-big up">
            ${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </span>
          <div className="tr-price-meta">
            <div className="tr-pm-item">
              <div className="tr-pm-val">
                {snapshot?.ask ? `$${parseFloat(snapshot.ask).toLocaleString()}` : "--"}
              </div>
              <div className="tr-pm-lbl">ASK</div>
            </div>
            <div className="tr-pm-item">
              <div className="tr-pm-val">
                {snapshot?.bid ? `$${parseFloat(snapshot.bid).toLocaleString()}` : "--"}
              </div>
              <div className="tr-pm-lbl">BID</div>
            </div>
          </div>
        </div>
      </div>

      {/* BODY */}
      <div className="tr-body tr-fu tr-d1">
        {/* CHART — real CandlestickChart with Lightweight Charts + all indicators */}
        <div className="tr-chart-area">
          <CandlestickChart
            fundingRate={fundingRate}
            onTradeSetupChange={handleTradeSetupChange}
          />
        </div>

        {/* BOTTOM TABS */}
        <div className="tr-tabs-area tr-fu tr-d2">
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
            {tab === "ORDER BOOK" && (
              <OrderBookPanel pair={selectedPair} liveBook={liveOrderBook} />
            )}
            {tab === "POSITIONS" &&
              (positions.length === 0 ? (
                <div className="tr-empty-state">
                  <div className="tr-es-lbl">No open positions</div>
                  <div className="tr-es-cta">{"\u25B8"} PLACE YOUR FIRST TRADE</div>
                </div>
              ) : (
                <table className="tr-ptbl">
                  <thead>
                    <tr>
                      <th>PAIR</th>
                      <th>SIZE</th>
                      <th>ENTRY</th>
                      <th>PNL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((pos) => {
                      const posPair = pairs.find((p) => p.id === pos.pair_id);
                      const pnl = parseFloat(pos.unrealized_pnl_quote);
                      return (
                        <tr key={pos.pair_id}>
                          <td>
                            <span className="tr-sym">{posPair?.symbol ?? "?"}</span>
                          </td>
                          <td>{formatDecimal(pos.base_qty, 8)}</td>
                          <td>{formatUsd(pos.avg_entry_price)}</td>
                          <td className={pnl >= 0 ? "tr-pos" : "tr-neg"}>
                            {formatUsd(pos.unrealized_pnl_quote)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ))}
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
                      <th>STATUS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openOrders.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <span className={o.side === "BUY" ? "tr-side-b" : "tr-side-s"}>
                            {o.side}
                          </span>
                        </td>
                        <td>{o.type}</td>
                        <td>{o.qty}</td>
                        <td>{o.limit_price ?? "MKT"}</td>
                        <td className="tr-dim">{o.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ))}
            {tab === "TRADES" && (
              <div className="tr-empty-state">
                <div className="tr-es-lbl">No recent trades</div>
                <div className="tr-es-cta">{"\u25B8"} TRADE HISTORY WILL APPEAR HERE</div>
              </div>
            )}
          </div>
        </div>

        {/* ORDER PANEL */}
        <OrderPanel
          pair={selectedPair}
          position={currentPosition}
          quoteBalance={quoteBalance}
        />
      </div>

      {/* Ticker is provided by AppLayout's <TickerBar /> */}
    </div>
  );
}
