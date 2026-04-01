/**
 * UnifiedOrderPanel — shared order form used by both TradingPage and LiveMatchView.
 *
 * Features:
 *   - LONG / SHORT direction toggle
 *   - MARKET / LIMIT order type
 *   - USD-first amount input (converted to base qty for API)
 *   - Optional Take Profit / Stop Loss (creates trigger orders via OCO after fill)
 *   - Optional Trailing Stop (offset in USD)
 *   - Open position card with real-time P&L, value, TP/SL display, close button
 *   - Available balance display
 */

import { useState, useEffect, useCallback } from "react";
import { useAppStore } from "@/stores/appStore";
import { useTradingStore } from "@/stores/tradingStore";
import { placeOrder } from "@/api/endpoints/trading";
import { createTrigger, createOco, listTriggers, cancelTrigger } from "@/api/endpoints/triggers";
import { formatDecimal } from "@/lib/decimal";
import type { Position, TradingPair, TriggerOrder } from "@/types/api";
import type { AxiosError } from "axios";
import type { V1ApiError } from "@/types/api";

const ERROR_MAP: Record<string, string> = {
    INSUFFICIENT_BALANCE: "INSUFFICIENT BALANCE",
    POSITION_LIMIT: "POSITION LIMIT REACHED",
    PAIR_DISABLED: "PAIR DISABLED",
    RATE_LIMITED: "RATE LIMITED",
    insufficient_balance: "INSUFFICIENT BALANCE",
    insufficient_liquidity: "INSUFFICIENT LIQUIDITY",
};

function fmtUsd(n: number): string {
    return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface UnifiedOrderPanelProps {
    pair: TradingPair;
    position: Position | null;
    quoteBalance: number;
    onOrderFilled: () => void;
    classPrefix?: string;
}

export function UnifiedOrderPanel({
    pair,
    position,
    quoteBalance,
    onOrderFilled,
    classPrefix = "tr",
}: UnifiedOrderPanelProps) {
    const orderType = useTradingStore((s) => s.orderType);
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
    const [usdAmount, setUsdAmount] = useState("");
    const [leverage, setLeverage] = useState(1);
    const [posLeverage, setPosLeverage] = useState(1);
    const [tpPrice, setTpPrice] = useState("");
    const [slPrice, setSlPrice] = useState("");
    const [tslOffset, setTslOffset] = useState("");
    const [btnState, setBtnState] = useState<"idle" | "success" | "error">("idle");
    const [errorMsg, setErrorMsg] = useState("");
    const [closing, setClosing] = useState(false);
    const [tpSlMsg, setTpSlMsg] = useState("");
    const [lastOrderUsd, setLastOrderUsd] = useState<number | null>(null);
    const [lastOrderFee, setLastOrderFee] = useState<number | null>(null);

    // Active triggers for position card display
    const [activeTriggers, setActiveTriggers] = useState<TriggerOrder[]>([]);
    const [editingTp, setEditingTp] = useState(false);
    const [editingSl, setEditingSl] = useState(false);
    const [editTpVal, setEditTpVal] = useState("");
    const [editSlVal, setEditSlVal] = useState("");

    // Fetch triggers for current pair
    const fetchTriggers = useCallback(async () => {
        if (!selectedPairId) return;
        try {
            const res = await listTriggers({ pairId: selectedPairId, status: "ACTIVE" });
            setActiveTriggers(res.data.data ?? []);
        } catch { /* non-fatal */ }
    }, [selectedPairId]);

    useEffect(() => { fetchTriggers(); }, [fetchTriggers]);

    // Reset on pair change
    useEffect(() => {
        setBtnState("idle");
        setErrorMsg("");
        setUsdAmount("");
        setTpPrice("");
        setSlPrice("");
        setTslOffset("");
        setTpSlMsg("");
        setEditingTp(false);
        setEditingSl(false);
    }, [selectedPairId]);

    const [baseSymbol] = pair.symbol.split("/") as [string, string];
    const currentPrice = snapshot?.last
        ? parseFloat(snapshot.last)
        : pair.last_price
            ? parseFloat(pair.last_price)
            : 0;

    const effectivePrice =
        orderType === "LIMIT" && limitPrice ? parseFloat(limitPrice) : currentPrice;

    // USD → base conversion (leverage applied)
    const usdNum = usdAmount ? parseFloat(usdAmount) : 0;
    const effectiveUsd = usdNum * leverage;
    const baseQty = effectiveUsd > 0 && effectivePrice > 0 ? effectiveUsd / effectivePrice : 0;
    const baseQtyStr = baseQty > 0 ? baseQty.toFixed(8) : "";

    // Fee calculation (on effective size)
    const estFee = effectiveUsd > 0 ? (effectiveUsd * (pair.taker_fee_bps / 10000)) : 0;

    // Position info
    const posQty = position ? parseFloat(position.base_qty) : 0;
    const hasPosition = position && posQty !== 0;
    const posDirection: "LONG" | "SHORT" | null = hasPosition ? (posQty > 0 ? "LONG" : "SHORT") : null;
    const posAbsQty = Math.abs(posQty);
    const posEntryPrice = position ? parseFloat(position.avg_entry_price) : 0;
    const posUsdSize = posAbsQty * posEntryPrice;
    const posCurrentValue = posAbsQty * currentPrice;
    const pnlValue = hasPosition ? (currentPrice - posEntryPrice) * posQty : 0;
    const pnlPct = posUsdSize > 0 ? (pnlValue / posUsdSize) * 100 : 0;

    // Derive TP/SL/TSL from active triggers
    const tpTrigger = activeTriggers.find((t) => t.kind === "TAKE_PROFIT_MARKET");
    const slTrigger = activeTriggers.find((t) => t.kind === "STOP_MARKET");
    const tslTrigger = activeTriggers.find((t) => t.kind === "TRAILING_STOP_MARKET");
    const tslCurrentStop = tslTrigger ? parseFloat(tslTrigger.trigger_price) : 0;

    // TP/SL estimates
    const tpNum = tpPrice ? parseFloat(tpPrice) : 0;
    const slNum = slPrice ? parseFloat(slPrice) : 0;
    const tslNum = tslOffset ? parseFloat(tslOffset) : 0;
    const tpEstProfit = tpNum > 0 && baseQty > 0
        ? (activeMode === "LONG" ? (tpNum - effectivePrice) : (effectivePrice - tpNum)) * baseQty
        : 0;
    const slEstLoss = slNum > 0 && baseQty > 0
        ? (activeMode === "LONG" ? (slNum - effectivePrice) : (effectivePrice - slNum)) * baseQty
        : 0;
    const tpEstPct = usdNum > 0 && tpEstProfit !== 0 ? (tpEstProfit / usdNum) * 100 : 0;  // % of margin
    const slEstPct = usdNum > 0 && slEstLoss !== 0 ? (slEstLoss / usdNum) * 100 : 0;

    // Validations
    const tpValid = !tpNum || (activeMode === "LONG" ? tpNum > effectivePrice : tpNum < effectivePrice);
    const slValid = !slNum || (activeMode === "LONG" ? slNum < effectivePrice : slNum > effectivePrice);
    const slDistance = slNum > 0 && effectivePrice > 0 ? Math.abs(effectivePrice - slNum) : 0;

    const tpError = tpNum > 0 && !tpValid
        ? (activeMode === "LONG" ? "Take profit must be above entry for a long position" : "Take profit must be below entry for a short position")
        : null;
    const slError = slNum > 0 && !slValid
        ? (activeMode === "LONG" ? "Stop loss must be below entry for a long position" : "Stop loss must be above entry for a short position")
        : null;
    const tslError = tslNum > 0
        ? (tslNum <= 0
            ? "Trailing stop offset must be greater than 0"
            : tslNum >= effectiveUsd
                ? "Trailing stop offset must be less than your position size"
                : slDistance > 0 && tslNum >= slDistance
                    ? "Trailing stop offset must be less than your stop loss distance"
                    : null)
        : null;
    const hasValidationError = !!(tpError || slError || tslError);

    const limitWarn = orderType === "LIMIT" && limitPrice
        ? (activeMode === "LONG" && parseFloat(limitPrice) > currentPrice
            ? "Price above market — will fill immediately"
            : activeMode === "SHORT" && parseFloat(limitPrice) < currentPrice
                ? "Price below market — will fill immediately"
                : null)
        : null;

    // Sync direction → store orderSide
    const handleModeChange = useCallback((mode: "LONG" | "SHORT") => {
        setActiveMode(mode);
        setOrderSide(mode === "LONG" ? "BUY" : "SELL");
    }, [setOrderSide]);

    useEffect(() => {
        setOrderSide(activeMode === "LONG" ? "BUY" : "SELL");
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Sync USD → store qty (base units)
    useEffect(() => {
        setQty(baseQtyStr);
    }, [baseQtyStr, setQty]);

    // Submit button label
    const isLong = activeMode === "LONG";
    const btnLabel = (() => {
        if (orderSubmitting) return "PLACING...";
        if (btnState === "success") return tpSlMsg || "ORDER PLACED";
        if (btnState === "error") return errorMsg || "FAILED";
        if (hasPosition && posDirection === activeMode) return `ADD TO ${activeMode}`;
        if (hasPosition && posDirection !== activeMode) return "CLOSE & REVERSE";
        return `OPEN ${isLong ? "LONG" : "SHORT"}`;
    })();

    const handlePlaceOrder = async () => {
        if (!appInitialized || !baseQtyStr) return;
        setErrorMsg("");
        setTpSlMsg("");
        setBtnState("idle");
        try {
            const result = await submitOrder();
            const fills = result?.fills ?? [];
            const filledQty = fills.reduce((sum: number, f: { qty: string }) => sum + parseFloat(f.qty), 0);

            // Create TP/SL triggers if specified and order filled
            if (filledQty > 0 && selectedPairId) {
                const closeSide = (isLong ? "SELL" : "BUY") as "BUY" | "SELL";
                const qtyStr = filledQty.toFixed(8);
                try {
                    if (tpNum && slNum && tpValid && slValid) {
                        await createOco({
                            pairId: selectedPairId,
                            legA: { kind: "STOP_MARKET", side: closeSide, triggerPrice: slPrice, qty: qtyStr },
                            legB: { kind: "TAKE_PROFIT_MARKET", side: closeSide, triggerPrice: tpPrice, qty: qtyStr },
                        });
                        setTpSlMsg("ORDER + TP/SL SET");
                    } else if (tpNum && tpValid) {
                        await createTrigger({
                            pairId: selectedPairId,
                            kind: "TAKE_PROFIT_MARKET",
                            side: closeSide,
                            triggerPrice: tpPrice,
                            qty: qtyStr,
                        });
                        setTpSlMsg("ORDER + TP SET");
                    } else if (slNum && slValid) {
                        await createTrigger({
                            pairId: selectedPairId,
                            kind: "STOP_MARKET",
                            side: closeSide,
                            triggerPrice: slPrice,
                            qty: qtyStr,
                        });
                        setTpSlMsg("ORDER + SL SET");
                    }

                    // Create trailing stop if specified
                    if (tslNum > 0) {
                        const initialStop = isLong
                            ? (currentPrice - tslNum).toFixed(8)
                            : (currentPrice + tslNum).toFixed(8);
                        await createTrigger({
                            pairId: selectedPairId,
                            kind: "TRAILING_STOP_MARKET",
                            side: closeSide,
                            triggerPrice: initialStop,
                            qty: qtyStr,
                            trailingOffset: tslNum.toFixed(8),
                        });
                        setTpSlMsg((prev) => prev ? prev + " + TSL" : "ORDER + TSL SET");
                    }
                } catch (tpSlErr) {
                    const ax = tpSlErr as AxiosError<{ code?: string; message?: string }>;
                    const reason = ax.response?.data?.message ?? ax.response?.data?.code ?? ax.message ?? "unknown";
                    setTpSlMsg(`TP/SL FAILED: ${reason}`);
                }
            }

            setBtnState("success");
            setLastOrderUsd(effectiveUsd);
            setLastOrderFee(estFee);
            if (usdNum > 0) setPosLeverage(leverage);
            setUsdAmount("");
            setTpPrice("");
            setSlPrice("");
            setTslOffset("");
            onOrderFilled();
            fetchTriggers();
            setTimeout(() => { setBtnState("idle"); setTpSlMsg(""); }, 2500);
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
            await placeOrder(
                { pairId: selectedPairId, side: closeSide, type: "MARKET", qty: posAbsQty.toFixed(8) },
                crypto.randomUUID(),
            );
            onOrderFilled();
            fetchTriggers();
        } catch {
            setErrorMsg("Close failed");
            setBtnState("error");
            setTimeout(() => setBtnState("idle"), 3000);
        } finally {
            setClosing(false);
        }
    };

    const handleEditTrigger = async (oldTrigger: TriggerOrder, newPrice: string) => {
        try {
            await cancelTrigger(oldTrigger.id);
            await createTrigger({
                pairId: oldTrigger.pair_id,
                kind: oldTrigger.kind,
                side: oldTrigger.side,
                triggerPrice: newPrice,
                qty: oldTrigger.qty,
            });
            fetchTriggers();
        } catch { /* non-fatal */ }
        setEditingTp(false);
        setEditingSl(false);
    };

    const handleMax = () => {
        if (quoteBalance > 0) {
            setUsdAmount(Math.floor(quoteBalance * 100) / 100 + "");
        }
    };

    const p = classPrefix;

    const btnClass = (() => {
        if (btnState === "success") return `${p}-place-btn success`;
        if (btnState === "error") return `${p}-place-btn error`;
        return `${p}-place-btn ${isLong ? "buy" : "sell"}`;
    })();

    const smallLabel: React.CSSProperties = { color: "rgba(255,255,255,0.3)", letterSpacing: 2, fontSize: 8 };
    const smallVal: React.CSSProperties = { color: "rgba(255,255,255,0.7)", fontSize: 10 };

    return (
        <div className={`${p}-order-section`}>
            {/* ── DIRECTION ── */}
            <div className={`${p}-dir-toggle`}>
                <div
                    className={`${p}-dir-btn ${p === "lmv" ? "long" : `${p}-dir-long`}${activeMode === "LONG" ? " active" : ""}`}
                    onClick={() => handleModeChange("LONG")}
                >
                    LONG
                </div>
                <div
                    className={`${p}-dir-btn ${p === "lmv" ? "short" : `${p}-dir-short`}${activeMode === "SHORT" ? " active" : ""}`}
                    onClick={() => handleModeChange("SHORT")}
                >
                    SHORT
                </div>
            </div>

            {/* ── ORDER TYPE ── */}
            <div className={`${p}-type-toggle`}>
                {(["MARKET", "LIMIT"] as const).map((t) => (
                    <div
                        key={t}
                        className={`${p}-tt${orderType === t ? " active" : ""}`}
                        onClick={() => {
                            setOrderType(t);
                            if (t === "LIMIT" && !limitPrice && snapshot?.last) setLimitPrice(snapshot.last);
                        }}
                    >
                        {t}
                    </div>
                ))}
            </div>

            {/* ── LEVERAGE ── */}
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                {([1, 2, 3, 5, 10] as const).map((lv) => (
                    <div
                        key={lv}
                        onClick={() => setLeverage(lv)}
                        style={{
                            flex: 1, textAlign: "center", padding: "5px 0",
                            fontSize: 10, letterSpacing: 1, cursor: "pointer",
                            border: `1px solid ${leverage === lv ? "var(--ar-orange, var(--g, #00ff41))" : "rgba(255,255,255,0.08)"}`,
                            color: leverage === lv ? "var(--ar-orange, var(--g, #00ff41))" : "rgba(255,255,255,0.3)",
                            background: leverage === lv ? "rgba(255,255,255,0.04)" : "transparent",
                        }}
                    >
                        {lv}x
                    </div>
                ))}
            </div>
            {leverage > 1 && (
                <div style={{ fontSize: 9, color: "#f59e0b", marginBottom: 8, letterSpacing: 1 }}>
                    {leverage}x leverage amplifies both gains and losses
                </div>
            )}

            {/* ── LIMIT PRICE ── */}
            {orderType === "LIMIT" && (
                <div className={`${p}-field`}>
                    <label>LIMIT PRICE</label>
                    <div className={`${p}-field-wrap`}>
                        <input type="number" placeholder={currentPrice ? currentPrice.toFixed(2) : "0.00"} value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} />
                        <span className={`${p}-field-unit`}>USD</span>
                    </div>
                    {limitWarn && <div style={{ fontSize: 9, color: "#f59e0b", marginTop: 4, letterSpacing: 1 }}>{limitWarn}</div>}
                </div>
            )}

            {/* ── AMOUNT (USD) ── */}
            <div className={`${p}-field`}>
                <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>AMOUNT</span>
                    <span style={{ color: "var(--ar-orange, var(--g, #00ff41))", cursor: "pointer", fontSize: 9, letterSpacing: 2 }} onClick={handleMax}>MAX</span>
                </label>
                <div className={`${p}-field-wrap`}>
                    <input type="number" placeholder="0.00" value={usdAmount} onChange={(e) => { setUsdAmount(e.target.value); setLastOrderUsd(null); setLastOrderFee(null); }} />
                    <span className={`${p}-field-unit`}>USD</span>
                </div>
                {baseQty > 0 && <div style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", marginTop: 3, letterSpacing: 1 }}>
                    ≈ {baseQty.toFixed(4)} {baseSymbol}{leverage > 1 ? `  (${leverage}x = ${fmtUsd(effectiveUsd)} effective)` : ""}
                </div>}
            </div>

            {/* ── TAKE PROFIT ── */}
            <div className={`${p}-field`}>
                <label>TAKE PROFIT</label>
                <div className={`${p}-field-wrap`}>
                    <input type="number" placeholder={isLong ? "above entry" : "below entry"} value={tpPrice} onChange={(e) => setTpPrice(e.target.value)} />
                    <span className={`${p}-field-unit`}>USD</span>
                </div>
                {tpError && <div style={{ fontSize: 9, color: "#ff3b3b", marginTop: 3 }}>{tpError}</div>}
                {!tpError && tpNum > 0 && tpEstProfit !== 0 && <div style={{ fontSize: 9, color: tpEstProfit > 0 ? "#00ff41" : "#ff3b3b", marginTop: 3 }}>Est. profit: {tpEstProfit >= 0 ? "+" : ""}{fmtUsd(tpEstProfit)} ({tpEstPct >= 0 ? "+" : ""}{tpEstPct.toFixed(1)}%)</div>}
            </div>

            {/* ── STOP LOSS ── */}
            <div className={`${p}-field`}>
                <label>STOP LOSS</label>
                <div className={`${p}-field-wrap`}>
                    <input type="number" placeholder={isLong ? "below entry" : "above entry"} value={slPrice} onChange={(e) => setSlPrice(e.target.value)} />
                    <span className={`${p}-field-unit`}>USD</span>
                </div>
                {slError && <div style={{ fontSize: 9, color: "#ff3b3b", marginTop: 3 }}>{slError}</div>}
                {!slError && slNum > 0 && slEstLoss !== 0 && <div style={{ fontSize: 9, color: slEstLoss < 0 ? "#ff3b3b" : "#00ff41", marginTop: 3 }}>Est. loss: {slEstLoss >= 0 ? "+" : ""}{fmtUsd(slEstLoss)} ({slEstPct >= 0 ? "+" : ""}{slEstPct.toFixed(1)}%)</div>}
            </div>

            {/* ── TRAILING STOP ── */}
            <div className={`${p}-field`}>
                <label>TRAILING STOP</label>
                <div className={`${p}-field-wrap`}>
                    <input type="number" placeholder="offset in USD" value={tslOffset} onChange={(e) => setTslOffset(e.target.value)} />
                    <span className={`${p}-field-unit`}>USD</span>
                </div>
                {tslError && <div style={{ fontSize: 9, color: "#ff3b3b", marginTop: 3 }}>{tslError}</div>}
                {!tslError && tslNum > 0 && currentPrice > 0 && (
                    <div style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", marginTop: 3 }}>
                        Stops at {fmtUsd(isLong ? currentPrice - tslNum : currentPrice + tslNum)} if price stays at current level
                    </div>
                )}
            </div>

            {/* ── SUMMARY ── */}
            <div className={`${p}-summary`}>
                <div className={`${p}-sum-row`}>
                    <span className={`${p}-sum-lbl`}>ENTRY PRICE</span>
                    <span className={`${p}-sum-val`}>{orderType === "LIMIT" && limitPrice ? fmtUsd(parseFloat(limitPrice)) : currentPrice > 0 ? fmtUsd(currentPrice) : "MARKET"}</span>
                </div>
                <div className={`${p}-sum-row`}>
                    <span className={`${p}-sum-lbl`}>POSITION SIZE</span>
                    <span className={`${p}-sum-val`}>{effectiveUsd > 0 ? fmtUsd(effectiveUsd) : lastOrderUsd ? fmtUsd(lastOrderUsd) : "--"}</span>
                </div>
                <div className={`${p}-sum-row`}>
                    <span className={`${p}-sum-lbl`}>FEE ({pair.taker_fee_bps} bps)</span>
                    <span className={`${p}-sum-val`}>{estFee > 0 ? fmtUsd(estFee) : lastOrderFee ? fmtUsd(lastOrderFee) : "--"}</span>
                </div>
                <div className={`${p}-sum-row`}>
                    <span className={`${p}-sum-lbl`} style={{ color: "rgba(255,255,255,0.35)" }}>AVAILABLE</span>
                    <span className={`${p}-sum-val`} style={{ color: "#fff" }}>${formatDecimal(quoteBalance.toString(), 2)} USD</span>
                </div>
            </div>

            {/* ── SUBMIT ── */}
            <button className={btnClass} disabled={orderSubmitting || !usdAmount || usdNum <= 0 || !appInitialized || hasValidationError} onClick={handlePlaceOrder}>
                {btnLabel}
            </button>

            {/* ── OPEN POSITION CARD ── */}
            {hasPosition && (
                <div style={{
                    marginTop: 12, padding: "12px",
                    border: `1px solid ${posDirection === "LONG" ? "rgba(0,255,65,0.2)" : "rgba(255,59,59,0.2)"}`,
                    background: posDirection === "LONG" ? "rgba(0,255,65,0.03)" : "rgba(255,59,59,0.03)",
                }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 2, color: posDirection === "LONG" ? "#00ff41" : "#ff3b3b" }}>
                            {baseSymbol} {posDirection}{posLeverage > 1 ? ` ${posLeverage}x` : ""}
                        </span>
                        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", letterSpacing: 1 }}>
                            {fmtUsd(posUsdSize)}
                        </span>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px", fontSize: 10, marginBottom: 8 }}>
                        <div>
                            <span style={smallLabel}>ENTRY</span>
                            <div style={smallVal}>{fmtUsd(posEntryPrice)}</div>
                        </div>
                        <div>
                            <span style={smallLabel}>CURRENT</span>
                            <div style={smallVal}>{fmtUsd(currentPrice)}</div>
                        </div>
                        <div>
                            <span style={smallLabel}>VALUE</span>
                            <div style={smallVal}>{fmtUsd(posCurrentValue)}</div>
                        </div>
                        <div>
                            <span style={smallLabel}>P&L</span>
                            <div style={{ color: pnlValue >= 0 ? "#00ff41" : "#ff3b3b", fontWeight: 700, fontSize: 10 }}>
                                {pnlValue >= 0 ? "+" : ""}{fmtUsd(pnlValue)} ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%)
                            </div>
                        </div>

                        {/* TP display */}
                        <div>
                            <span style={smallLabel}>TP</span>
                            {editingTp && tpTrigger ? (
                                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                    <input type="number" value={editTpVal} onChange={(e) => setEditTpVal(e.target.value)}
                                        style={{ width: 70, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff", fontSize: 10, padding: "2px 4px", fontFamily: "inherit" }} />
                                    <span style={{ cursor: "pointer", color: "#00ff41", fontSize: 10 }} onClick={() => handleEditTrigger(tpTrigger, editTpVal)}>OK</span>
                                    <span style={{ cursor: "pointer", color: "rgba(255,255,255,0.3)", fontSize: 10 }} onClick={() => setEditingTp(false)}>X</span>
                                </div>
                            ) : (
                                <div style={{ color: tpTrigger ? "#00ff41" : "rgba(255,255,255,0.2)" }}>
                                    {tpTrigger ? fmtUsd(parseFloat(tpTrigger.trigger_price)) : "--"}
                                    {tpTrigger && <span style={{ cursor: "pointer", marginLeft: 6, fontSize: 9, color: "rgba(255,255,255,0.3)" }} onClick={() => { setEditTpVal(tpTrigger.trigger_price); setEditingTp(true); }}>✏️</span>}
                                </div>
                            )}
                        </div>

                        {/* SL display */}
                        <div>
                            <span style={smallLabel}>SL</span>
                            {editingSl && slTrigger ? (
                                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                    <input type="number" value={editSlVal} onChange={(e) => setEditSlVal(e.target.value)}
                                        style={{ width: 70, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff", fontSize: 10, padding: "2px 4px", fontFamily: "inherit" }} />
                                    <span style={{ cursor: "pointer", color: "#ff3b3b", fontSize: 10 }} onClick={() => handleEditTrigger(slTrigger, editSlVal)}>OK</span>
                                    <span style={{ cursor: "pointer", color: "rgba(255,255,255,0.3)", fontSize: 10 }} onClick={() => setEditingSl(false)}>X</span>
                                </div>
                            ) : (
                                <div style={{ color: slTrigger ? "#ff3b3b" : "rgba(255,255,255,0.2)" }}>
                                    {slTrigger ? fmtUsd(parseFloat(slTrigger.trigger_price)) : "--"}
                                    {slTrigger && <span style={{ cursor: "pointer", marginLeft: 6, fontSize: 9, color: "rgba(255,255,255,0.3)" }} onClick={() => { setEditSlVal(slTrigger.trigger_price); setEditingSl(true); }}>✏️</span>}
                                </div>
                            )}
                        </div>

                        {/* Trailing stop display */}
                        {tslTrigger && (
                            <div style={{ gridColumn: "1 / -1" }}>
                                <span style={smallLabel}>TSL</span>
                                <div style={{ color: "#f59e0b", fontSize: 10 }}>
                                    ${parseFloat(tslTrigger.trailing_offset ?? "0").toFixed(2)} offset (stop: {fmtUsd(tslCurrentStop)})
                                </div>
                            </div>
                        )}
                    </div>

                    <button
                        disabled={closing}
                        onClick={handleClosePosition}
                        style={{
                            width: "100%", padding: "8px 0",
                            background: "rgba(255,59,59,0.15)", border: "1px solid rgba(255,59,59,0.4)",
                            color: "#ff3b3b", fontSize: 10, letterSpacing: 3,
                            cursor: closing ? "not-allowed" : "pointer",
                            opacity: closing ? 0.5 : 1, fontFamily: "inherit",
                        }}
                    >
                        {closing ? "CLOSING..." : "CLOSE POSITION"}
                    </button>
                </div>
            )}
        </div>
    );
}
