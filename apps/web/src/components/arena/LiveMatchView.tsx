import { useState, useEffect, useCallback } from "react";
import Decimal from "decimal.js-light";
import { useAppStore } from "@/stores/appStore";
import { useAuthStore } from "@/stores/authStore";
import { useTradingStore } from "@/stores/tradingStore";
import { CandlestickChart } from "@/components/trading/CandlestickChart";
import { getPositions } from "@/api/endpoints/analytics";
import { placeOrder } from "@/api/endpoints/trading";
import { forfeitMatch, getActiveMatch, getMatch, type Match } from "@/api/endpoints/matches";
import { formatDecimal } from "@/lib/decimal";
import { setActiveCompetitionId } from "@/api/client";
import { MatchHeaderBar } from "./MatchHeaderBar";
import { OpponentActivityFeed } from "./OpponentActivityFeed";
import { MatchEndOverlay } from "./MatchEndOverlay";
import type { Position, TradingPair } from "@/types/api";
import type { AxiosError } from "axios";
import type { V1ApiError } from "@/types/api";

/* ─────────────────────────────────────────
   LIVE MATCH VIEW CSS
───────────────────────────────────────── */
const LMV_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap');

  .lmv-wrap, .lmv-wrap *, .lmv-wrap *::before, .lmv-wrap *::after {
    box-sizing: border-box;
  }

  .lmv-wrap {
    --ar-g: #00ff41; --ar-red: #ff3b3b; --ar-orange: #FF6B00;
    --ar-gold: #FFD700; --ar-bg: #040404; --ar-bg2: #080808;
    --ar-border: rgba(255,107,0,0.16); --ar-borderW: rgba(255,255,255,0.06);
    --ar-muted: rgba(255,255,255,0.3); --ar-faint: rgba(255,255,255,0.05);
    --ar-bebas: 'Bebas Neue', sans-serif; --ar-mono: 'Space Mono', monospace;
    font-family: var(--ar-mono);
    color: rgba(255,255,255,0.88);
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }

  /* ── HEADER BAR ── */
  .lmv-header {
    height: 56px;
    min-height: 56px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 20px;
    background: var(--ar-bg2);
    border-bottom: 1px solid var(--ar-orange);
    gap: 16px;
  }
  .lmv-h-left, .lmv-h-right {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
  }
  .lmv-h-right { justify-content: flex-end; }
  .lmv-h-center {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }
  .lmv-h-name {
    font-family: var(--ar-mono);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 2px;
  }
  .lmv-h-pnl {
    font-family: var(--ar-bebas);
    font-size: 22px;
    letter-spacing: 2px;
    padding: 2px 10px;
  }
  .lmv-h-vs {
    font-family: var(--ar-bebas);
    font-size: 20px;
    color: var(--ar-orange);
    opacity: 0.6;
    letter-spacing: 3px;
  }
  .lmv-h-badge {
    font-family: var(--ar-mono);
    font-size: 9px;
    letter-spacing: 3px;
    color: var(--ar-orange);
    border: 1px solid var(--ar-orange);
    padding: 3px 8px;
    animation: lmv-pulse 2s ease-in-out infinite;
  }
  @keyframes lmv-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  .lmv-h-timer {
    font-family: var(--ar-mono);
    font-size: 13px;
    letter-spacing: 2px;
    color: rgba(255,255,255,0.6);
  }
  .lmv-h-timer.urgent {
    color: var(--ar-red);
    animation: lmv-pulse 1s ease-in-out infinite;
  }
  .lmv-forfeit-btn {
    font-family: var(--ar-mono);
    font-size: 10px;
    letter-spacing: 2px;
    color: var(--ar-red);
    border: 1px solid var(--ar-red);
    background: transparent;
    padding: 4px 12px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .lmv-forfeit-btn:hover {
    background: rgba(255,59,59,0.1);
  }

  /* ── MODAL ── */
  .lmv-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .lmv-modal {
    background: #0c0c0c;
    border: 1px solid var(--ar-orange);
    padding: 32px;
    max-width: 420px;
    width: 90%;
  }
  .lmv-modal-title {
    font-family: var(--ar-bebas);
    font-size: 28px;
    letter-spacing: 4px;
    color: var(--ar-red);
    margin-bottom: 12px;
  }
  .lmv-modal-text {
    font-size: 11px;
    line-height: 1.6;
    color: rgba(255,255,255,0.6);
    margin-bottom: 24px;
  }
  .lmv-modal-actions {
    display: flex;
    gap: 12px;
  }

  /* ── SPLIT AREA ── */
  .lmv-split {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .lmv-side {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .lmv-side.opponent {
    background: rgba(204,0,0,0.03);
  }
  .lmv-divider {
    width: 2px;
    background: var(--ar-orange);
    flex-shrink: 0;
  }

  /* ── CHART CONTAINER ── */
  .lmv-chart-wrap {
    flex: 1;
    min-height: 200px;
    position: relative;
    overflow: hidden;
  }
  .lmv-chart-wrap.readonly {
    pointer-events: none;
  }
  .lmv-opp-label {
    position: absolute;
    top: 8px;
    left: 12px;
    font-family: var(--ar-mono);
    font-size: 10px;
    letter-spacing: 3px;
    color: rgba(255,255,255,0.4);
    z-index: 10;
    pointer-events: none;
  }

  /* ── STATS ROW ── */
  .lmv-stats {
    height: 48px;
    min-height: 48px;
    display: flex;
    align-items: center;
    gap: 24px;
    padding: 0 16px;
    border-top: 1px solid var(--ar-borderW);
    border-bottom: 1px solid var(--ar-borderW);
    font-size: 11px;
  }
  .lmv-stat-lbl {
    font-size: 8px;
    letter-spacing: 3px;
    color: var(--ar-muted);
    margin-right: 6px;
  }
  .lmv-stat-val {
    font-family: var(--ar-mono);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 1px;
  }

  /* ── ORDER PANEL (reuse TradingPage styles) ── */
  .lmv-order-section {
    min-height: 0;
    overflow-y: auto;
    padding: 12px 16px;
    border-top: 1px solid var(--ar-borderW);
  }

  /* Order form inline styles */
  .lmv-dir-toggle {
    display: flex;
    gap: 0;
    margin-bottom: 8px;
  }
  .lmv-dir-btn {
    flex: 1;
    text-align: center;
    padding: 8px;
    font-family: var(--ar-mono);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 3px;
    cursor: pointer;
    border: 1px solid var(--ar-borderW);
    background: transparent;
    color: rgba(255,255,255,0.4);
    transition: all 0.15s;
  }
  .lmv-dir-btn.long.active {
    color: var(--ar-g);
    border-color: var(--ar-g);
    background: rgba(0,255,65,0.06);
  }
  .lmv-dir-btn.short.active {
    color: var(--ar-red);
    border-color: var(--ar-red);
    background: rgba(255,59,59,0.06);
  }
  .lmv-type-toggle {
    display: flex;
    gap: 0;
    margin-bottom: 8px;
  }
  .lmv-tt {
    flex: 1;
    text-align: center;
    padding: 6px;
    font-size: 9px;
    letter-spacing: 2px;
    color: var(--ar-muted);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.15s;
  }
  .lmv-tt.active {
    color: var(--ar-orange);
    border-bottom-color: var(--ar-orange);
  }
  .lmv-field {
    margin-bottom: 8px;
  }
  .lmv-field label {
    display: block;
    font-size: 8px;
    letter-spacing: 3px;
    color: var(--ar-muted);
    margin-bottom: 4px;
  }
  .lmv-field-wrap {
    display: flex;
    align-items: center;
    border: 1px solid var(--ar-borderW);
    background: rgba(255,255,255,0.03);
  }
  .lmv-field-wrap input {
    flex: 1;
    background: transparent;
    border: none;
    color: #fff;
    font-family: var(--ar-mono);
    font-size: 12px;
    padding: 8px 10px;
    outline: none;
    width: 0;
  }
  .lmv-field-unit {
    font-size: 9px;
    letter-spacing: 2px;
    color: var(--ar-muted);
    padding-right: 10px;
    flex-shrink: 0;
  }
  .lmv-pct-row {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
  }
  .lmv-pct {
    flex: 1;
    text-align: center;
    padding: 4px;
    font-size: 9px;
    letter-spacing: 1px;
    color: var(--ar-muted);
    border: 1px solid var(--ar-borderW);
    cursor: pointer;
    transition: all 0.15s;
  }
  .lmv-pct.active, .lmv-pct:hover {
    color: var(--ar-orange);
    border-color: var(--ar-orange);
    background: rgba(255,107,0,0.06);
  }
  .lmv-summary {
    margin-bottom: 8px;
  }
  .lmv-sum-row {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    padding: 2px 0;
  }
  .lmv-sum-lbl { color: var(--ar-muted); }
  .lmv-sum-val { color: rgba(255,255,255,0.7); }
  .lmv-place-btn {
    width: 100%;
    padding: 10px;
    font-family: var(--ar-mono);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 3px;
    border: none;
    cursor: pointer;
    transition: all 0.15s;
    margin-bottom: 8px;
  }
  .lmv-place-btn.buy {
    background: var(--ar-g);
    color: #000;
  }
  .lmv-place-btn.sell {
    background: var(--ar-red);
    color: #fff;
  }
  .lmv-place-btn.success {
    background: var(--ar-g);
    color: #000;
  }
  .lmv-place-btn.error {
    background: var(--ar-red);
    color: #fff;
  }
  .lmv-place-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .lmv-close-btn {
    width: 100%;
    padding: 8px;
    font-family: var(--ar-mono);
    font-size: 10px;
    letter-spacing: 2px;
    color: var(--ar-red);
    border: 1px solid rgba(255,59,59,0.3);
    background: rgba(255,59,59,0.06);
    cursor: pointer;
    transition: all 0.15s;
    margin-bottom: 8px;
  }
  .lmv-close-btn:hover { background: rgba(255,59,59,0.12); }
  .lmv-close-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .lmv-balance-row {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    padding: 8px 0;
    border-top: 1px solid var(--ar-borderW);
  }
  .lmv-bal-lbl { color: var(--ar-muted); letter-spacing: 2px; font-size: 8px; }
  .lmv-bal-val { color: #fff; font-weight: 700; }

  /* ── OPPONENT FEED ── */
  .lmv-opp-feed {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 16px;
    border-top: 1px solid var(--ar-borderW);
  }
  .lmv-feed-label {
    font-size: 8px;
    letter-spacing: 3px;
    color: var(--ar-muted);
    margin-bottom: 8px;
  }
  .lmv-feed-empty {
    font-size: 11px;
    color: rgba(255,255,255,0.2);
    text-align: center;
    padding: 32px 16px;
    line-height: 1.6;
  }
  .lmv-feed-list { display: flex; flex-direction: column; gap: 4px; }
  .lmv-feed-entry {
    display: flex;
    gap: 8px;
    font-size: 10px;
    padding: 4px 0;
    animation: lmv-fadeIn 0.3s ease-out;
  }
  @keyframes lmv-fadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .lmv-feed-ts { color: var(--ar-muted); font-size: 9px; flex-shrink: 0; }
  .lmv-feed-action { color: rgba(255,255,255,0.6); }

  /* ── MATCH END OVERLAY ── */
  .lmv-end-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.85);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }
  .lmv-end-card {
    text-align: center;
    padding: 48px 64px;
    border: 1px solid var(--ar-orange);
    background: #0a0a0a;
    min-width: 340px;
  }
  .lmv-end-result {
    font-family: var(--ar-bebas);
    font-size: 48px;
    letter-spacing: 6px;
    margin-bottom: 24px;
  }
  .lmv-end-pnl-row {
    display: flex;
    justify-content: center;
    gap: 40px;
    margin-bottom: 24px;
  }
  .lmv-end-label {
    font-size: 8px;
    letter-spacing: 3px;
    color: var(--ar-muted);
    margin-bottom: 4px;
  }
  .lmv-end-val {
    font-family: var(--ar-bebas);
    font-size: 28px;
    letter-spacing: 2px;
  }
  .lmv-end-elo-section {
    display: flex;
    justify-content: center;
    gap: 40px;
    margin-bottom: 32px;
    padding-top: 16px;
    border-top: 1px solid var(--ar-borderW);
  }
  .lmv-end-actions {
    display: flex;
    justify-content: center;
    gap: 12px;
  }
`;

/* ── ERROR MESSAGES ── */
const ERROR_MAP: Record<string, string> = {
    INSUFFICIENT_BALANCE: "INSUFFICIENT BALANCE",
    POSITION_LIMIT: "POSITION LIMIT REACHED",
    PAIR_DISABLED: "PAIR DISABLED",
    RATE_LIMITED: "RATE LIMITED",
};

function fmtUsd(n: number): string {
    return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ── COMPACT ORDER PANEL ── */
function MatchOrderPanel({
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
    const [closing, setClosing] = useState(false);

    useEffect(() => {
        setBtnState("idle");
        setErrorMsg("");
    }, [selectedPairId]);

    const [baseSymbol] = pair.symbol.split("/") as [string, string];
    const currentPrice = snapshot?.last ? parseFloat(snapshot.last) : (pair.last_price ? parseFloat(pair.last_price) : 0);
    const effectivePrice = orderType === "LIMIT" && limitPrice ? parseFloat(limitPrice) : currentPrice;
    const qtyNum = qty ? parseFloat(qty) : 0;
    const estTotal = qtyNum && effectivePrice ? (qtyNum * effectivePrice).toFixed(2) : null;
    const estFee = estTotal ? (parseFloat(estTotal) * (pair.taker_fee_bps / 10000)).toFixed(2) : null;

    const posQty = position ? parseFloat(position.base_qty) : 0;
    const hasPosition = position && posQty !== 0;
    const posDirection: "LONG" | "SHORT" | null = hasPosition ? (posQty > 0 ? "LONG" : "SHORT") : null;
    const posAbsQty = Math.abs(posQty);

    const handleModeChange = (mode: "LONG" | "SHORT") => {
        setActiveMode(mode);
        setOrderSide(mode === "LONG" ? "BUY" : "SELL");
    };

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
            const data = axErr.response?.data;
            let msg = "FAILED";
            if (data) {
                const code = "code" in data ? data.code : "error" in data ? data.error : "";
                const message = "message" in data ? data.message : "";
                msg = ERROR_MAP[code] ?? (typeof message === "string" && message ? message : "FAILED");
            }
            setErrorMsg(msg);
            setBtnState("error");
            setTimeout(() => setBtnState("idle"), 3000);
        }
    };

    const handleClosePosition = async () => {
        if (!hasPosition || !selectedPairId) return;
        setClosing(true);
        try {
            const closeSide = posQty > 0 ? "SELL" : "BUY";
            await placeOrder({ pairId: selectedPairId, side: closeSide, type: "MARKET", qty: posAbsQty.toFixed(8) }, crypto.randomUUID());
            onOrderFilled();
        } catch {
            setErrorMsg("Close failed");
            setBtnState("error");
            setTimeout(() => setBtnState("idle"), 3000);
        } finally {
            setClosing(false);
        }
    };

    const isLong = activeMode === "LONG";
    const btnLabel = (() => {
        if (orderSubmitting) return "PLACING...";
        if (btnState === "success") return "ORDER PLACED";
        if (btnState === "error") return errorMsg || "FAILED";
        const arrow = isLong ? "\u25B2" : "\u25BC";
        return `${arrow} ${isLong ? "LONG" : "SHORT"} ${orderType}`;
    })();
    const btnClass = (() => {
        if (btnState === "success") return "lmv-place-btn success";
        if (btnState === "error") return "lmv-place-btn error";
        return `lmv-place-btn ${isLong ? "buy" : "sell"}`;
    })();

    return (
        <div className="lmv-order-section">
            {/* Direction */}
            <div className="lmv-dir-toggle">
                <div className={`lmv-dir-btn long${activeMode === "LONG" ? " active" : ""}`} onClick={() => handleModeChange("LONG")}>LONG</div>
                <div className={`lmv-dir-btn short${activeMode === "SHORT" ? " active" : ""}`} onClick={() => handleModeChange("SHORT")}>SHORT</div>
            </div>

            {/* Order type */}
            <div className="lmv-type-toggle">
                {(["MARKET", "LIMIT"] as const).map((t) => (
                    <div key={t} className={`lmv-tt${orderType === t ? " active" : ""}`}
                        onClick={() => { setOrderType(t); if (t === "LIMIT" && !limitPrice && snapshot?.last) setLimitPrice(snapshot.last); }}>
                        {t}
                    </div>
                ))}
            </div>

            {/* Fields */}
            {orderType === "LIMIT" && (
                <div className="lmv-field">
                    <label>LIMIT PRICE</label>
                    <div className="lmv-field-wrap">
                        <input type="number" placeholder={currentPrice ? currentPrice.toFixed(2) : "0.00"} value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} />
                        <span className="lmv-field-unit">USD</span>
                    </div>
                </div>
            )}
            <div className="lmv-field">
                <label>QUANTITY</label>
                <div className="lmv-field-wrap">
                    <input type="number" placeholder="0.0000" value={qty} onChange={(e) => { setQty(e.target.value); setPct(null); }} />
                    <span className="lmv-field-unit">{baseSymbol}</span>
                </div>
            </div>
            <div className="lmv-pct-row">
                {[25, 50, 75, 100].map((p) => (
                    <div key={p} className={`lmv-pct${pct === p ? " active" : ""}`} onClick={() => handlePct(p)}>{p}%</div>
                ))}
            </div>

            {/* Summary */}
            <div className="lmv-summary">
                <div className="lmv-sum-row"><span className="lmv-sum-lbl">ESTIMATED</span><span className="lmv-sum-val">{estTotal ? fmtUsd(parseFloat(estTotal)) : "--"}</span></div>
                <div className="lmv-sum-row"><span className="lmv-sum-lbl">FEE</span><span className="lmv-sum-val">{estFee ?? "--"}</span></div>
            </div>

            {/* Place order */}
            <button className={btnClass} disabled={orderSubmitting || !qty || !appInitialized} onClick={handlePlaceOrder}>
                {btnLabel}
            </button>

            {/* Close position */}
            {hasPosition && (
                <button className="lmv-close-btn" disabled={closing} onClick={handleClosePosition}>
                    {closing ? "CLOSING..." : `\u2715 CLOSE ${posDirection} \u2014 ${posAbsQty.toFixed(4)} ${baseSymbol}`}
                </button>
            )}

            {/* Balance */}
            <div className="lmv-balance-row">
                <span className="lmv-bal-lbl">AVAILABLE</span>
                <span className="lmv-bal-val">${formatDecimal(quoteBalance.toString(), 2)} USD</span>
            </div>
        </div>
    );
}

/* ─────────────────────────────────────────
   MAIN LIVE MATCH VIEW
───────────────────────────────────────── */
interface LiveMatchViewProps {
    match: Match;
    onMatchEnd: () => void;
}

export function LiveMatchView({ match: initialMatch, onMatchEnd }: LiveMatchViewProps) {
    const userId = useAuthStore((s) => s.user?.id) ?? "";
    const pairs = useAppStore((s) => s.pairs);
    const wallets = useAppStore((s) => s.wallets);
    const selectedPairId = useTradingStore((s) => s.selectedPairId);
    const selectPair = useTradingStore((s) => s.selectPair);

    const [match, setMatch] = useState(initialMatch);
    const [positions, setPositions] = useState<Position[]>([]);
    const [showEndOverlay, setShowEndOverlay] = useState(false);

    const isChallenger = match.challenger_id === userId;
    const yourName = isChallenger ? (match.challenger_name ?? "YOU") : (match.opponent_name ?? "YOU");
    const opponentName = isChallenger ? (match.opponent_name ?? "OPPONENT") : (match.challenger_name ?? "OPPONENT");
    const yourPnl = isChallenger ? match.challenger_pnl_pct : match.opponent_pnl_pct;
    const opponentPnl = isChallenger ? match.opponent_pnl_pct : match.challenger_pnl_pct;
    const yourTrades = isChallenger ? match.challenger_trades_count : match.opponent_trades_count;
    const oppTrades = isChallenger ? match.opponent_trades_count : match.challenger_trades_count;

    // Tag orders with match ID while LiveMatchView is mounted
    useEffect(() => {
        setActiveCompetitionId(match.id);
        return () => { setActiveCompetitionId(null); };
    }, [match.id]);

    // Clear competition tag when match ends (overlay shown)
    useEffect(() => {
        if (showEndOverlay) setActiveCompetitionId(null);
    }, [showEndOverlay]);

    // Default to first active pair on mount
    useEffect(() => {
        if (!selectedPairId && pairs.length > 0) {
            selectPair(pairs[0]!.id);
        }
    }, [selectedPairId, pairs, selectPair]);

    // Inject CSS
    useEffect(() => {
        const id = "lmv-css";
        if (!document.getElementById(id)) {
            const s = document.createElement("style");
            s.id = id;
            s.textContent = LMV_CSS;
            document.head.appendChild(s);
        }
    }, []);

    // Poll match state every 15s
    useEffect(() => {
        const poll = async () => {
            try {
                const { data } = await getActiveMatch();
                if (data.match) {
                    setMatch(data.match);
                    if (data.match.status === "COMPLETED" || data.match.status === "FORFEITED") {
                        setShowEndOverlay(true);
                    }
                } else {
                    // No active match — fetch final state by ID for accurate result display
                    try {
                        const { data: full } = await getMatch(match.id);
                        setMatch(full.match);
                    } catch { /* ignore — overlay will use existing match state */ }
                    setShowEndOverlay(true);
                }
            } catch { /* ignore */ }
        };
        const id = setInterval(poll, 15_000);
        return () => clearInterval(id);
    }, [match.id]);

    // Check for match end by timer
    useEffect(() => {
        if (!match.ends_at) return;
        const check = () => {
            if (new Date(match.ends_at!).getTime() <= Date.now()) {
                setShowEndOverlay(true);
            }
        };
        const id = setInterval(check, 1000);
        return () => clearInterval(id);
    }, [match.ends_at]);

    // Fetch positions
    const refreshPositions = useCallback(() => {
        getPositions()
            .then((res) => setPositions(res.data.positions))
            .catch(() => {});
    }, []);

    useEffect(() => {
        refreshPositions();
    }, [selectedPairId, refreshPositions]);

    useEffect(() => {
        const handler = () => refreshPositions();
        window.addEventListener("sse:trade.created", handler);
        return () => window.removeEventListener("sse:trade.created", handler);
    }, [refreshPositions]);

    // Handle forfeit
    const handleForfeit = async () => {
        try {
            await forfeitMatch(match.id);
            // Fetch full match with JOINed player data (elo, names)
            const { data: full } = await getMatch(match.id);
            setMatch(full.match);
            setShowEndOverlay(true);
        } catch { /* ignore */ }
    };

    // Derived data
    const selectedPair = pairs.find((p) => p.id === selectedPairId);
    const quoteAssetId = selectedPair?.quote_asset_id;
    const quoteWallet = wallets.find((w) => w.asset_id === quoteAssetId);
    const quoteBalance = quoteWallet ? new Decimal(quoteWallet.balance).minus(quoteWallet.reserved ?? "0").toNumber() : 0;
    const currentPosition = positions.find((p) => p.pair_id === selectedPairId) ?? null;

    const yourPnlNum = parseFloat(yourPnl ?? "0");

    if (!selectedPair) {
        return <div className="lmv-wrap" style={{ alignItems: "center", justifyContent: "center", fontSize: 11, color: "rgba(255,255,255,0.3)" }}>NO PAIRS AVAILABLE</div>;
    }

    return (
        <div className="lmv-wrap">
            {/* MATCH HEADER */}
            <MatchHeaderBar
                match={match}
                yourPnl={yourPnl}
                opponentPnl={opponentPnl}
                yourName={yourName}
                opponentName={opponentName}
                onForfeit={handleForfeit}
            />

            {/* SPLIT VIEW */}
            <div className="lmv-split">
                {/* ── YOUR SIDE ── */}
                <div className="lmv-side">
                    {/* Chart */}
                    <div className="lmv-chart-wrap">
                        <CandlestickChart />
                    </div>

                    {/* Stats row */}
                    <div className="lmv-stats">
                        <div>
                            <span className="lmv-stat-lbl">BALANCE</span>
                            <span className="lmv-stat-val">{fmtUsd(quoteBalance)}</span>
                        </div>
                        <div>
                            <span className="lmv-stat-lbl">P&L</span>
                            <span className="lmv-stat-val" style={{ color: yourPnlNum >= 0 ? "var(--ar-g)" : "var(--ar-red)" }}>
                                {yourPnlNum >= 0 ? "+" : ""}{yourPnlNum.toFixed(2)}%
                            </span>
                        </div>
                        <div>
                            <span className="lmv-stat-lbl">TRADES</span>
                            <span className="lmv-stat-val">{yourTrades}</span>
                        </div>
                    </div>

                    {/* Order panel */}
                    <MatchOrderPanel
                        pair={selectedPair}
                        position={currentPosition}
                        quoteBalance={quoteBalance}
                        onOrderFilled={refreshPositions}
                    />
                </div>

                {/* ── DIVIDER ── */}
                <div className="lmv-divider" />

                {/* ── OPPONENT SIDE ── */}
                <div className="lmv-side opponent">
                    {/* Opponent chart (read-only) */}
                    <div className="lmv-chart-wrap readonly">
                        <div className="lmv-opp-label">OPPONENT VIEW</div>
                        <CandlestickChart />
                    </div>

                    {/* Opponent stats row */}
                    <div className="lmv-stats">
                        <div>
                            <span className="lmv-stat-lbl">P&L</span>
                            <span className="lmv-stat-val" style={{ color: parseFloat(opponentPnl ?? "0") >= 0 ? "var(--ar-g)" : "var(--ar-red)" }}>
                                {parseFloat(opponentPnl ?? "0") >= 0 ? "+" : ""}{parseFloat(opponentPnl ?? "0").toFixed(2)}%
                            </span>
                        </div>
                        <div>
                            <span className="lmv-stat-lbl">TRADES</span>
                            <span className="lmv-stat-val">{oppTrades}</span>
                        </div>
                        <div>
                            <span className="lmv-stat-lbl">PAIR</span>
                            <span className="lmv-stat-val">{selectedPair.symbol.split("/")[0]}</span>
                        </div>
                    </div>

                    {/* Opponent activity feed */}
                    <OpponentActivityFeed />
                </div>
            </div>

            {/* MATCH END OVERLAY */}
            {showEndOverlay && (
                <MatchEndOverlay
                    match={match}
                    userId={userId}
                    onBackToArena={() => {
                        setShowEndOverlay(false);
                        onMatchEnd();
                    }}
                />
            )}
        </div>
    );
}
