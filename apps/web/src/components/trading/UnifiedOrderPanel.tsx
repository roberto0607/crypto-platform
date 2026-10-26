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
 *   - Leverage (ISOLATED margin), only where the server allows more than 1x
 *     (GET /leverage, useLeverageInfo): the selector, MARGIN input, notional,
 *     fee, est. liq price, free-USD AVAILABLE and account EQUITY. With
 *     leverage off or a 1x cap the panel and every request body are exactly
 *     as before (UnifiedOrderPanel.leverageOff.test.tsx).
 *   - ISOLATED position card: leverage, margin, liq price, mark, margin
 *     health, loss-capped P&L and return on margin.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useAppStore } from "@/stores/appStore";
import { useTradingStore } from "@/stores/tradingStore";
import { usePairPricesStore } from "@/stores/pairPricesStore";
import { placeOrder } from "@/api/endpoints/trading";
import { createTrigger, createOco } from "@/api/endpoints/triggers";
import { formatDecimal } from "@/lib/decimal";
import { useToast } from "@/components/ToastProvider";
import { usePnlFlash } from "@/hooks/usePnlFlash";
import { useBuyingPower, useOrderWallets } from "@/hooks/useBuyingPower";
import { useLeverageInfo } from "@/hooks/useLeverageInfo";
import { SHOW_LEVERAGE_SELECTOR } from "@/lib/featureFlags";
import {
    leverageOptions,
    orderPreview,
    maxMargin,
    isolatedPositionView,
    scopeEquity,
    healthTone,
} from "@/lib/leverageUi";
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
    stale_price_source: "PRICE FEED DELAYED — RETRY",
    match_ended: "MATCH ENDED",
    reduce_only_no_position: "POSITION ALREADY CLOSED",
    leverage_exceeds_cap: "LEVERAGE ABOVE YOUR LIMIT",
    leverage_mismatch: "CLOSE THE POSITION TO CHANGE LEVERAGE",
    spot_orders_open: "CANCEL YOUR OPEN ORDERS ON THIS PAIR FIRST",
    isolated_orders_open: "CANCEL YOUR OPEN ORDERS ON THIS PAIR FIRST",
};

/** Margin-health bar colours (§4): green > 50%, amber 25–50%, red < 25% (pulses). */
const HEALTH_COLORS = { ok: "#00ff41", warn: "#f59e0b", danger: "#ff3b3b" } as const;

function fmtUsd(n: number): string {
    return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Fees on small orders are fractions of a cent — show 4 dp so the
 *  estimate matches what the ledger charges (e.g. $0.0250, not $0.03). */
function fmtFee(n: number): string {
    return n >= 1 ? fmtUsd(n) : "$" + n.toFixed(4);
}

/**
 * Quick-amount (#15): a fraction of the quote balance, floored to whole cents.
 * Non-positive balance or fraction → 0 (so 25/50/75/MAX never set NaN).
 */
export function computeQuickAmount(balance: number, frac: number): number {
    if (!(balance > 0) || !(frac > 0)) return 0;
    return Math.floor(balance * frac * 100) / 100;
}

/**
 * Trailing-stop offset validation. The offset is a USD *price* distance (the
 * server's stop = high-water mark ∓ offset), so it is bounded by the price,
 * not by the position's notional: 0 < offset < current price. The server
 * enforces the same rule (api triggers/trailingOffset.ts). It must also sit
 * inside the stop-loss distance when an SL is set. Empty input = no trailing
 * stop. Returns the error message, or null.
 */
export function trailingOffsetError(offsetInput: string, currentPrice: number, slDistance: number): string | null {
    if (offsetInput.trim() === "") return null;
    const offset = parseFloat(offsetInput);
    if (!(offset > 0)) return "Trailing stop offset must be greater than 0";
    if (currentPrice > 0 && offset >= currentPrice) return "Trailing stop offset must be less than the current price";
    if (slDistance > 0 && offset >= slDistance) return "Trailing stop offset must be less than your stop loss distance";
    return null;
}

/**
 * Leverage risk escalation (#16). Maps a leverage multiple to a visual tier:
 *   1,2 (and any non-risky value) → neutral accent
 *   3,5 → warn amber (5x a touch stronger than 3x)
 *   10  → danger red
 * `color` drives the selected button border+text and the warning copy;
 * `faintBorder` tints UNSELECTED risky buttons so they read as risky pre-click.
 * Pure (mirrors prepareBook/spreadRecenterScrollTop) — unit-tested.
 */
export function leverageRisk(lv: number): {
    tier: "neutral" | "warn" | "danger";
    color: string;
    faintBorder: string;
} {
    if (lv === 10) return { tier: "danger", color: "#ef4444", faintBorder: "rgba(239,68,68,0.25)" };
    if (lv === 5) return { tier: "warn", color: "#f59e0b", faintBorder: "rgba(245,158,11,0.25)" };
    if (lv === 3) return { tier: "warn", color: "#fbbf24", faintBorder: "rgba(251,191,36,0.25)" };
    return { tier: "neutral", color: "var(--ar-orange, var(--g, #00ff41))", faintBorder: "rgba(255,255,255,0.08)" };
}

/**
 * OPEN-button label (#18). For the plain OPEN case with a real size, enrich with
 * the order NOTIONAL and base qty:
 *   `OPEN LONG · $1,000.00 · 0.0158 BTC`
 * Zero/empty qty → plain `OPEN LONG`/`OPEN SHORT`. Caller keeps the PLACING /
 * ORDER PLACED / FAILED / ADD TO / CLOSE & REVERSE states untouched. Pure.
 */
export function openButtonLabel(args: {
    mode: "LONG" | "SHORT";
    baseQty: number;
    effectiveUsd: number;
    baseSymbol: string;
    fmtUsd: (n: number) => string;
}): string {
    const { mode, baseQty, effectiveUsd, baseSymbol, fmtUsd: fmt } = args;
    if (baseQty > 0) {
        return `OPEN ${mode} · ${fmt(effectiveUsd)} · ${baseQty.toFixed(4)} ${baseSymbol}`;
    }
    return `OPEN ${mode}`;
}

interface UnifiedOrderPanelProps {
    pair: TradingPair;
    position: Position | null;
    /** Every open position of the account this panel trades (for EQUITY). Defaults to `position`. */
    positions?: Position[];
    onOrderFilled: () => void;
    classPrefix?: string;
}

export function UnifiedOrderPanel({
    pair,
    position,
    positions,
    onOrderFilled,
    classPrefix = "tr",
}: UnifiedOrderPanelProps) {
    const orderType = useTradingStore((s) => s.orderType);
    const limitPrice = useTradingStore((s) => s.limitPrice);
    const orderSubmitting = useTradingStore((s) => s.orderSubmitting);
    const appInitialized = useAppStore((s) => s.initialized);
    // Gate placement on a live SSE feed — no orders on stale/absent market data.
    const sseConnectionState = useAppStore((s) => s.sseConnectionState);
    const marketReady = sseConnectionState === "connected";
    const setOrderSide = useTradingStore((s) => s.setOrderSide);
    const setOrderType = useTradingStore((s) => s.setOrderType);
    const setQty = useTradingStore((s) => s.setQty);
    const setLimitPrice = useTradingStore((s) => s.setLimitPrice);
    const submitOrder = useTradingStore((s) => s.submitOrder);
    const snapshot = useTradingStore((s) => s.snapshot);
    const selectedPairId = useTradingStore((s) => s.selectedPairId);
    const pairPrice = usePairPricesStore((s) => s.prices[pair.id]);
    // AVAILABLE = buying power (2× rule, lib/buyingPower.ts): cash minus what
    // open shorts hold, live with wallet.updated and prices. Null = a shorted
    // asset has no price yet. MAX/quick amounts never go below 0.
    const spotAvailable = useBuyingPower(pair.quote_asset_id);
    const { addToast } = useToast();

    // ── Leverage: the server decides (GET /leverage). ──
    // `leveraged` = this order trades ISOLATED and may go above 1x. Only then
    // does anything here differ from the pre-leverage panel.
    const levInfo = useLeverageInfo(pair.id);
    const isolated = levInfo?.marginMode === "ISOLATED";
    const levCap = isolated ? levInfo!.cap : 1;
    const leveraged = SHOW_LEVERAGE_SELECTOR && isolated && levCap > 1;
    const levOptions = leverageOptions(levCap);
    // An open ISOLATED position fixes the leverage until it's closed.
    const lockedLeverage = levInfo?.positionLeverage ? Number(levInfo.positionLeverage) : null;
    const orderWallets = useOrderWallets();
    const quoteWallet = orderWallets?.find((w) => w.asset_id === pair.quote_asset_id) ?? null;
    // ISOLATED: what's free is the USD the order can draw (margin is already
    // out of it, and no base is held), not the 2× spot rule.
    const freeUsd = quoteWallet ? parseFloat(quoteWallet.balance) - parseFloat(quoteWallet.reserved ?? "0") : null;
    const available = isolated ? freeUsd : spotAvailable;
    const quoteBalance = Math.max(0, available ?? 0);

    const [activeMode, setActiveMode] = useState<"LONG" | "SHORT">("LONG");
    const [usdAmount, setUsdAmount] = useState("");
    const [chosenLeverage, setLeverage] = useState(1);
    const [tpPrice, setTpPrice] = useState("");
    const [slPrice, setSlPrice] = useState("");
    const [tslOffset, setTslOffset] = useState("");
    const [btnState, setBtnState] = useState<"idle" | "success" | "error">("idle");
    const [errorMsg, setErrorMsg] = useState("");
    const [closing, setClosing] = useState(false);
    const [tpSlMsg, setTpSlMsg] = useState("");
    const [lastOrderUsd, setLastOrderUsd] = useState<number | null>(null);
    const [lastOrderFee, setLastOrderFee] = useState<number | null>(null);

    // Active triggers (shared with the Open Orders dock via the store)
    const activeTriggers = useTradingStore((s) => s.activeTriggers);
    const fetchTriggers = useTradingStore((s) => s.refreshTriggers);
    const updateTrigger = useTradingStore((s) => s.updateTrigger);
    const [editingTp, setEditingTp] = useState(false);
    const [editingSl, setEditingSl] = useState(false);
    const [editTpVal, setEditTpVal] = useState("");
    const [editSlVal, setEditSlVal] = useState("");

    // Fetch triggers for the current pair, and re-fetch whenever the server
    // fires or cancels one (e.g. canceled because the position closed) or a
    // fill lands that may have closed a position.
    useEffect(() => { fetchTriggers(); }, [selectedPairId, fetchTriggers]);
    useEffect(() => {
        const refetch = () => { fetchTriggers(); };
        const events = ["sse:trigger.fired", "sse:trigger.canceled", "sse:trade.created", "sse:reconnected"];
        for (const e of events) window.addEventListener(e, refetch);
        return () => { for (const e of events) window.removeEventListener(e, refetch); };
    }, [fetchTriggers]);

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
    // The snapshot-first ordering is load-bearing for replay mode:
    // onReplayTick writes snapshot but NOT pairPricesStore, so during a
    // replay session pairPrice holds the stale real-market value while
    // snapshot.last has the replay price. Do not "simplify" this ternary —
    // collapsing to pairPrice alone would break replay-mode pricing.
    const currentPrice = snapshot?.last
        ? parseFloat(snapshot.last)
        : pairPrice ?? 0;

    const effectivePrice =
        orderType === "LIMIT" && limitPrice ? parseFloat(limitPrice) : currentPrice;

    const leverage = leveraged
        ? (lockedLeverage ?? (levOptions.includes(chosenLeverage) ? chosenLeverage : 1))
        : 1;

    // USD → base conversion. Without leverage the order is exactly the amount
    // entered. Leveraged, the amount is the MARGIN: notional = margin × L,
    // sized (rounded down) by lib/margin.ts the way the engine locks it.
    const usdNum = usdAmount ? parseFloat(usdAmount) : 0;
    const preview = leveraged
        ? orderPreview({
            margin: usdNum, leverage, price: effectivePrice, takerBps: pair.taker_fee_bps,
            mmrBps: levInfo!.mmrBps, side: activeMode,
        })
        : null;
    const effectiveUsd = preview ? preview.notional : usdNum;
    const baseQty = preview
        ? (preview.qty ? parseFloat(preview.qty) : 0)
        : effectiveUsd > 0 && effectivePrice > 0 ? effectiveUsd / effectivePrice : 0;
    const baseQtyStr = preview ? preview.qty : baseQty > 0 ? baseQty.toFixed(8) : "";

    // Fee estimate (on order size). A MARKET order is always the taker.
    // A LIMIT order pays the taker rate if it crosses now and the maker rate
    // if it rests, so estimate at the taker rate (the higher one) and label both.
    const estFee = preview ? preview.fee : effectiveUsd > 0 ? (effectiveUsd * (pair.taker_fee_bps / 10000)) : 0;
    const feeLabel = orderType === "LIMIT"
        ? `FEE (${pair.taker_fee_bps} bps taker / ${pair.maker_fee_bps} maker)`
        : `FEE (${pair.taker_fee_bps} bps)`;

    // Position info
    const posQty = position ? parseFloat(position.base_qty) : 0;
    const hasPosition = position && posQty !== 0;
    const posDirection: "LONG" | "SHORT" | null = hasPosition ? (posQty > 0 ? "LONG" : "SHORT") : null;
    const posAbsQty = Math.abs(posQty);
    const posEntryPrice = position ? parseFloat(position.avg_entry_price) : 0;
    const posUsdSize = posAbsQty * posEntryPrice;
    const posCurrentValue = posAbsQty * currentPrice;
    // An ISOLATED position: margin, liq, health, P&L capped at the margin,
    // return on margin (lib/leverageUi). Health uses the pair's maintenance
    // margin from GET /leverage; until that arrives, the server's own figure.
    const isoView = hasPosition && position!.margin_mode === "ISOLATED"
        ? isolatedPositionView({
            baseQty: position!.base_qty,
            entry: position!.avg_entry_price,
            margin: position!.isolated_margin ?? "0",
            leverage: position!.leverage ?? "1",
            liqPrice: position!.liq_price ?? null,
            mmrBps: levInfo?.mmrBps ?? 0,
            mark: currentPrice,
        })
        : null;
    const isoHealth = isoView
        ? (levInfo ? isoView.health : Number(position!.margin_health ?? "1"))
        : 1;
    const pnlValue = isoView ? isoView.unrealizedPnl : hasPosition ? (currentPrice - posEntryPrice) * posQty : 0;
    const pnlPct = isoView ? isoView.roePct : posUsdSize > 0 ? (pnlValue / posUsdSize) * 100 : 0;

    // EQUITY (leveraged accounts): USD + every open position's worth, an
    // ISOLATED one at margin + capped uPnL (the USD wallet no longer holds
    // its margin, so a wallet-only number reads low). Same as the server's
    // accountEquity. Marks: the selected pair live, others at their tick.
    const pairPrices = usePairPricesStore((s) => s.prices);
    const accountPositions = positions ?? (position ? [position] : []);
    const equity = leveraged && quoteWallet
        ? scopeEquity(parseFloat(quoteWallet.balance), accountPositions,
            (id) => (id === pair.id ? currentPrice : pairPrices[id] ?? null))
        : null;

    // Flash the P&L number green/red when it moves (throttled, micro-noise suppressed).
    const pnlFlash = usePnlFlash(pnlValue, selectedPairId ?? "", 0.01);

    // Position card entrance — animate when a position first appears or the pair
    // changes, but not on P&L re-renders, and not on a page refresh that lands on
    // an already-open position. A position is identified by its pair.
    const posIdentity = hasPosition ? position!.pair_id : null;
    const seenPos = useRef<string | null | undefined>(undefined);
    const [cardKey, setCardKey] = useState(0);
    const [cardEntering, setCardEntering] = useState(false);
    useEffect(() => {
        if (seenPos.current === undefined) {
            // Initial mount — record the baseline without animating.
            seenPos.current = posIdentity;
            return;
        }
        if (posIdentity && posIdentity !== seenPos.current) {
            setCardKey((k) => k + 1);
            setCardEntering(true);
        }
        seenPos.current = posIdentity;
    }, [posIdentity]);

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
    const tslError = trailingOffsetError(tslOffset, currentPrice, slDistance);
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
        return openButtonLabel({
            mode: isLong ? "LONG" : "SHORT",
            baseQty, effectiveUsd, baseSymbol, fmtUsd,
        });
    })();
    // The enriched OPEN label (with notional + qty) is the only long one — let it
    // wrap/shrink so it never clips at the narrower arena width.
    const btnLabelEnriched =
        !orderSubmitting && btnState === "idle" && !hasPosition && baseQty > 0;

    const handlePlaceOrder = async () => {
        if (!appInitialized || !marketReady || !baseQtyStr) return;
        setErrorMsg("");
        setTpSlMsg("");
        setBtnState("idle");
        try {
            // `leverage` only for a leveraged order: otherwise the body is
            // exactly the pre-leverage one.
            const result = await submitOrder(leveraged ? { leverage } : undefined);
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
            // Reduce-only: if the position is already gone (liquidated, a
            // stop fired, the match ended) or smaller, the server trims or
            // rejects it — a CLOSE can never open a new position.
            await placeOrder(
                { pairId: selectedPairId, side: closeSide, type: "MARKET", qty: posAbsQty.toFixed(8), reduceOnly: true },
                crypto.randomUUID(),
            );
            onOrderFilled();
            fetchTriggers();
        } catch (err) {
            const code = (err as AxiosError<{ error?: string }>).response?.data?.error;
            if (code === "reduce_only_no_position") {
                // Nothing left to close: refresh so the card goes away.
                addToast("info", "Position already closed.");
                onOrderFilled();
                fetchTriggers();
            } else {
                setErrorMsg(code && ERROR_MAP[code] ? ERROR_MAP[code] : "Close failed");
                setBtnState("error");
                setTimeout(() => setBtnState("idle"), 3000);
            }
        } finally {
            setClosing(false);
        }
    };

    const handleEditTrigger = async (oldTrigger: TriggerOrder, newPrice: string) => {
        // One atomic PATCH: the trigger keeps its id and OCO link (the old
        // cancel-then-create orphaned the other leg). On failure the old
        // trigger is untouched, so just say so and keep the edit open.
        try {
            await updateTrigger(oldTrigger.id, { triggerPrice: newPrice });
        } catch (err: any) {
            const msg = err?.response?.data?.message;
            addToast("error", msg ?? "Couldn't update trigger — the old one is still active. Try again.");
            return;
        }
        setEditingTp(false);
        setEditingSl(false);
    };

    // 25/50/75/MAX quick-amount buttons (#15). MAX is just frac 1.
    const setQuickAmount = (frac: number) => {
        // Leveraged, the amount is margin: leave room for the fee on its notional.
        const pool = leveraged ? maxMargin(quoteBalance, leverage, pair.taker_fee_bps) : quoteBalance;
        const v = computeQuickAmount(pool, frac);
        if (v > 0) {
            setUsdAmount(v + "");
            setLastOrderUsd(null);
            setLastOrderFee(null);
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

            {/* ── LEVERAGE ── only where the server allows more than 1x. Only
                values ≤ the cap; locked to the open position's leverage. */}
            {leveraged && <>
            <div role="radiogroup" aria-label="Leverage" style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                {levOptions.map((lv) => {
                    const risk = leverageRisk(lv);
                    const selected = leverage === lv;
                    const locked = lockedLeverage !== null && !selected;
                    return (
                        <div
                            key={lv}
                            role="radio"
                            aria-checked={selected}
                            aria-disabled={locked}
                            onClick={() => { if (lockedLeverage === null) setLeverage(lv); }}
                            style={{
                                flex: 1, textAlign: "center", padding: "5px 0",
                                fontSize: 10, letterSpacing: 1,
                                cursor: lockedLeverage === null ? "pointer" : "not-allowed",
                                opacity: locked ? 0.35 : 1,
                                // Selected → tier color; unselected risky → faint tier tint
                                // so 3x/5x/10x read as risky before they're chosen.
                                border: `1px solid ${selected ? risk.color : risk.faintBorder}`,
                                color: selected ? risk.color : "rgba(255,255,255,0.3)",
                                background: selected ? "rgba(255,255,255,0.04)" : "transparent",
                            }}
                        >
                            {lv}x
                        </div>
                    );
                })}
            </div>
            {lockedLeverage !== null ? (
                <div style={{ fontSize: 9, color: "rgba(255,255,255,0.45)", marginBottom: 8, letterSpacing: 1 }}>
                    Close the position to change leverage
                </div>
            ) : leverage > 1 && (
                <div style={{ fontSize: 9, color: leverageRisk(leverage).color, marginBottom: 8, letterSpacing: 1 }}>
                    {leverage}x leverage amplifies both gains and losses
                </div>
            )}
            {levInfo?.blockedBy && (
                <div style={{ fontSize: 9, color: "#f59e0b", marginBottom: 8, letterSpacing: 1 }}>
                    Cancel your open orders on this pair to trade with leverage
                </div>
            )}
            </>}

            {/* LIMIT PRICE + AMOUNT share one row. In LIMIT mode the tr-pa-row CSS
                lays them out as two columns so the limit-price field adds no vertical
                height; in MARKET mode only AMOUNT is present and it stays full-width.
                Arena (lmv-pa-row) has no rule for this wrapper, so the fields stack
                exactly as before there. */}
            <div className={`${p}-pa-row`}>
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
                    <span>{leveraged ? "MARGIN" : "AMOUNT"}</span>
                    {/* 25/50/75/MAX quick-amount row (#15) — right-aligned on the label
                        row so panel height stays stable. Inert at zero balance. */}
                    <span style={{ display: "flex", gap: 8 }}>
                        {([0.25, 0.5, 0.75, 1] as const).map((frac) => (
                            <span
                                key={frac}
                                onClick={() => setQuickAmount(frac)}
                                style={{
                                    color: "var(--ar-orange, var(--g, #00ff41))",
                                    cursor: quoteBalance > 0 ? "pointer" : "default",
                                    opacity: quoteBalance > 0 ? 1 : 0.4,
                                    fontSize: 9, letterSpacing: 1,
                                }}
                            >
                                {frac === 1 ? "MAX" : `${frac * 100}%`}
                            </span>
                        ))}
                    </span>
                </label>
                <div className={`${p}-field-wrap`}>
                    <input type="number" placeholder="0.00" value={usdAmount} onChange={(e) => { setUsdAmount(e.target.value); setLastOrderUsd(null); setLastOrderFee(null); }} />
                    <span className={`${p}-field-unit`}>USD</span>
                </div>
                {baseQty > 0 && <div style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", marginTop: 3, letterSpacing: 1 }}>
                    ≈ {baseQty.toFixed(4)} {baseSymbol}{leveraged && ` · ${fmtUsd(effectiveUsd)} at ${leverage}x`}
                </div>}
            </div>
            </div>{/* /tr-pa-row */}

            {/* TAKE PROFIT + STOP LOSS share one 2-col row (same :has() mechanism as
                the LIMIT PRICE|AMOUNT tr-pa-row). Pairing the two stacked fields into
                one row reclaims a full field's vertical height (~77px) — exactly what
                TRAILING STOP needs to stay above the pinned footer in the worst-case
                filled state (PR #50). Each column is self-contained (label + input +
                its OWN helper), and the grid's align-items:start keeps both inputs
                top-aligned even when only one column shows a helper. Arena (lmv-ts-row)
                has no rule, so the two fields stack vertically there exactly as before. */}
            <div className={`${p}-ts-row`}>
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
            </div>{/* /tr-ts-row */}

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

            {/* Sticky footer. No open position (trade page): keeps the cost summary +
                submit button always visible while TP/SL/TSL scroll above (display:contents
                in the arena). With a position open (both pages): the summary, submit AND
                the position card are one bottom-pinned group, the card last. The card
                used to be pinned on its own over a flowing summary, so it covered the
                FEE / AVAILABLE rows and the submit button whenever they scrolled under it. */}
            <div className={`${p}-order-footer${hasPosition ? ` ${p}-order-footer-with-position` : ` ${p}-order-footer-pinned`}`}>
            {/* ── SUMMARY ── */}
            <div className={`${p}-summary`}>
                <div className={`${p}-sum-row`}>
                    <span className={`${p}-sum-lbl`}>ENTRY PRICE</span>
                    <span className={`${p}-sum-val`}>{orderType === "LIMIT" && limitPrice ? fmtUsd(parseFloat(limitPrice)) : currentPrice > 0 ? fmtUsd(currentPrice) : "MARKET"}</span>
                </div>
                <div className={`${p}-sum-row`}>
                    <span className={`${p}-sum-lbl`}>{leveraged ? "NOTIONAL" : "POSITION SIZE"}</span>
                    <span className={`${p}-sum-val`}>{effectiveUsd > 0 ? fmtUsd(effectiveUsd) : lastOrderUsd ? fmtUsd(lastOrderUsd) : <span className={`${p}-sum-empty`}>--</span>}</span>
                </div>
                <div className={`${p}-sum-row`}>
                    <span className={`${p}-sum-lbl`}>{feeLabel}</span>
                    <span className={`${p}-sum-val`}>{estFee > 0 ? fmtFee(estFee) : lastOrderFee ? fmtFee(lastOrderFee) : <span className={`${p}-sum-empty`}>--</span>}</span>
                </div>
                {leveraged && (
                    <div className={`${p}-sum-row`}>
                        <span className={`${p}-sum-lbl`}>EST. LIQ PRICE</span>
                        <span
                            className={`${p}-sum-val`}
                            style={{ color: preview?.liqPrice ? "#f59e0b" : undefined }}
                            title={preview?.liqPrice
                                ? `Liquidation at ${fmtUsd(preview.liqPrice.toNumber())} (${preview.liqDistancePct! >= 0 ? "+" : ""}${preview.liqDistancePct!.toFixed(1)}% from entry): the margin, less the maintenance margin, used up`
                                : "A 1x long can't be liquidated"}
                        >
                            {preview?.liqPrice
                                ? fmtUsd(preview.liqPrice.toNumber())
                                : usdNum > 0 ? "NONE" : <span className={`${p}-sum-empty`}>--</span>}
                        </span>
                    </div>
                )}
                <div className={`${p}-sum-row`}>
                    <span className={`${p}-sum-lbl`} style={{ color: "rgba(255,255,255,0.35)" }}>AVAILABLE</span>
                    <span
                        className={`${p}-sum-val`}
                        style={{ color: available !== null && available < 0 ? "#ff3b3b" : "#fff" }}
                        title={leveraged ? "Free USD: your balance minus what open orders hold. Open positions' margin is already out of it." : "Cash minus what open shorts hold (2× their value)"}
                    >
                        {available === null ? "—" : `${available < 0 ? "-" : ""}$${formatDecimal(Math.abs(available).toString(), 2)} USD`}
                    </span>
                </div>
                {leveraged && (
                    <div className={`${p}-sum-row`}>
                        <span className={`${p}-sum-lbl`}>EQUITY</span>
                        <span className={`${p}-sum-val`} title="USD plus each open position's margin and P&L (a loss counts at most its margin)">
                            {equity === null ? "—" : `$${formatDecimal(equity.toString(), 2)} USD`}
                        </span>
                    </div>
                )}
            </div>

            {/* ── SUBMIT ── */}
            {!marketReady && (
                <div style={{ fontSize: 9, color: "#22d3ee", letterSpacing: 1, marginBottom: 6, textAlign: "center" }}>
                    waiting for market data…
                </div>
            )}
            <button
                className={btnClass}
                style={btnLabelEnriched ? { letterSpacing: 1, fontSize: 11, whiteSpace: "normal", lineHeight: 1.3 } : undefined}
                disabled={orderSubmitting || !usdAmount || usdNum <= 0 || !appInitialized || !marketReady || hasValidationError}
                onClick={handlePlaceOrder}
            >
                {btnLabel}
            </button>

            {/* ── OPEN POSITION CARD — last in the pinned footer group ── */}
            {hasPosition && (
                <div className={`${p}-position-card-sticky`}>
                    <div
                        key={cardKey}
                        className={cardEntering ? "position-card-enter" : undefined}
                        style={{
                            padding: "12px",
                            border: `1px solid ${posDirection === "LONG" ? "rgba(0,255,65,0.2)" : "rgba(255,59,59,0.2)"}`,
                            background: posDirection === "LONG" ? "rgba(0,255,65,0.03)" : "rgba(255,59,59,0.03)",
                            "--card-accent": posDirection === "LONG" ? "#00ff41" : "#ff3b3b",
                        } as React.CSSProperties}
                    >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 2, color: posDirection === "LONG" ? "#00ff41" : "#ff3b3b" }}>
                                {baseSymbol} {posDirection}
                                {isoView && (
                                    <span
                                        data-testid="position-leverage"
                                        style={{
                                            marginLeft: 6, padding: "0 4px", fontSize: 9, letterSpacing: 1,
                                            border: `1px solid ${leverageRisk(isoView.leverage).color}`,
                                            color: leverageRisk(isoView.leverage).color,
                                        }}
                                    >
                                        {isoView.leverage}x
                                    </span>
                                )}
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
                                <span style={smallLabel}>{isoView ? "MARK" : "CURRENT"}</span>
                                <div style={smallVal}>{fmtUsd(currentPrice)}</div>
                            </div>
                            {isoView ? (<>
                                <div>
                                    <span style={smallLabel}>MARGIN</span>
                                    <div style={smallVal}>{fmtUsd(isoView.margin)}</div>
                                </div>
                                <div>
                                    <span style={smallLabel}>LIQ PRICE</span>
                                    <div
                                        style={{ ...smallVal, color: isoView.liqPrice ? "#f59e0b" : smallVal.color }}
                                        title={isoView.liqPrice
                                            ? `Liquidation at ${fmtUsd(isoView.liqPrice)} (${((isoView.liqPrice / posEntryPrice - 1) * 100).toFixed(1)}% from entry)`
                                            : "A 1x long can't be liquidated"}
                                    >
                                        {isoView.liqPrice ? fmtUsd(isoView.liqPrice) : "NONE"}
                                    </div>
                                </div>
                            </>) : (
                            <div>
                                <span style={smallLabel}>VALUE</span>
                                <div style={smallVal}>{fmtUsd(posCurrentValue)}</div>
                            </div>
                            )}
                            <div>
                                <span style={smallLabel}>P&L</span>
                                <div
                                    key={pnlFlash.key}
                                    className={pnlFlash.dir ? "pnl-flash" : undefined}
                                    style={{
                                        color: pnlValue >= 0 ? "#00ff41" : "#ff3b3b",
                                        fontWeight: 700, fontSize: 10,
                                        // ISOLATED: on its own line under the label (the
                                        // SPOT card's layout is unchanged).
                                        display: isoView ? "table" : "inline-block",
                                        padding: "1px 4px", margin: "-1px -4px",
                                        borderRadius: 2,
                                        "--pnl-flash-tint": pnlFlash.dir === "up"
                                            ? "rgba(0,255,65,0.45)"
                                            : "rgba(255,59,59,0.45)",
                                    } as React.CSSProperties}
                                >
                                    {pnlValue >= 0 ? "+" : ""}{fmtUsd(pnlValue)}{!isoView && <> ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%)</>}
                                </div>
                            </div>
                            {isoView && (
                                <div>
                                    <span style={smallLabel} title="Unrealized P&L as a % of the position's margin">ROE</span>
                                    <div style={{ ...smallVal, color: pnlValue >= 0 ? "#00ff41" : "#ff3b3b", fontWeight: 700 }}>
                                        {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
                                    </div>
                                </div>
                            )}

                            {/* TP display */}
                            <div>
                                <span style={smallLabel}>TP</span>
                                {editingTp && tpTrigger ? (
                                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                        <input type="number" autoFocus value={editTpVal} onChange={(e) => setEditTpVal(e.target.value)}
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
                                        <input type="number" autoFocus value={editSlVal} onChange={(e) => setEditSlVal(e.target.value)}
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

                        {isoView && (
                            <div style={{ marginBottom: 8 }} data-testid="margin-health">
                                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, letterSpacing: 2, marginBottom: 3 }}>
                                    <span style={{ color: "rgba(255,255,255,0.3)" }}>MARGIN HEALTH</span>
                                    <span style={{ color: HEALTH_COLORS[healthTone(isoHealth)] }}>{Math.round(isoHealth * 100)}%</span>
                                </div>
                                <div
                                    role="meter"
                                    aria-label="Margin health"
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={Math.round(isoHealth * 100)}
                                    className={healthTone(isoHealth) === "danger" ? "margin-health-danger" : undefined}
                                    style={{ height: 4, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}
                                >
                                    <div style={{
                                        width: `${Math.max(0, Math.min(1, isoHealth)) * 100}%`, height: "100%",
                                        background: HEALTH_COLORS[healthTone(isoHealth)], transition: "width 0.3s",
                                    }} />
                                </div>
                            </div>
                        )}

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
                </div>
            )}
            </div>{/* /order-footer */}
        </div>
    );
}
