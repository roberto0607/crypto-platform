/**
 * UnifiedOrderPanel — the order form on /trade, free-play and match alike.
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
 *   - The open-position card (PositionCard): P&L first, liq distance and
 *     margin health, break-even, TP/SL on the position, close / reverse.
 *   - An order on the other side of an open position is labelled for what it
 *     does: REDUCE and CLOSE are one click, like any exchange; CLOSE & REVERSE
 *     asks for confirmation first, never a one-click flip. A MARKET REDUCE or
 *     CLOSE is reduce-only: the panel's position can be stale by the time the
 *     order lands, and the server trims it rather than open the other side.
 *   - MARKET preview from GET /v1/sim/quote (est. fill, slippage, notional,
 *     fee, est. liq at that fill); 25/50/75/MAX from its budget solve.
 *   - A rejection stays under the submit button until the next edit.
 *   - CLOSE POSITION and every confirm sit in a bar pinned to the bottom of
 *     the scrolling panel, so nothing can push them out of reach.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useAppStore } from "@/stores/appStore";
import { useTradingStore } from "@/stores/tradingStore";
import { usePairPricesStore } from "@/stores/pairPricesStore";
import { placeOrder } from "@/api/endpoints/trading";
import { getMarketQuote, type QuoteParams } from "@/api/endpoints/quote";
import { createTrigger, createOco } from "@/api/endpoints/triggers";
import { formatDecimal } from "@/lib/decimal";
import { useToast } from "@/components/ToastProvider";
import { usePnlFlash } from "@/hooks/usePnlFlash";
import { useBuyingPower, useOrderWallets } from "@/hooks/useBuyingPower";
import { useOrderScope } from "@/lib/orderScope";
import { useLeverageInfo } from "@/hooks/useLeverageInfo";
import { useLiquidationMark } from "@/hooks/useLiquidationMark";
import { useMarketQuotes } from "@/hooks/useMarketQuotes";
import { useMarkPriceStore } from "@/stores/markPriceStore";
import { SHOW_LEVERAGE_SELECTOR } from "@/lib/featureFlags";
import {
    leverageOptions,
    orderPreview,
    maxMargin,
    estLiqPrice,
    isolatedPositionView,
    scopeEquity,
} from "@/lib/leverageUi";
import { addPreview, reverseSummary } from "@/lib/positionCard";
import { CLIENT_OUTDATED, orderErrorText, quoteReasonText, fmtCompactUsd, type OrderErrorContext } from "@/lib/orderErrors";
import { PRICE_HELP } from "@/lib/priceHelp";
import { PositionCard, fmtQty, fmtSigned } from "@/components/trading/PositionCard";
import { ConfirmBox } from "@/components/trading/ConfirmBox";
import type { Position, TradingPair, TriggerOrder } from "@/types/api";
import type { AxiosError } from "axios";

const PRESETS = [0.25, 0.5, 0.75, 1] as const;
/** A preview left open re-quotes this often, so est. fill follows the book. */
const QUOTE_REFRESH_MS = 5_000;
const DIM: React.CSSProperties = { opacity: 0.45 };

function fmtUsd(n: number): string {
    return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Fees on small orders are fractions of a cent — show 4 dp so the
 *  estimate matches what the ledger charges (e.g. $0.0250, not $0.03). */
function fmtFee(n: number): string {
    return n >= 1 ? fmtUsd(n) : "$" + n.toFixed(4);
}

/** Two decimals, three under 0.01% (a real cost on a big order), never a false 0.000%. */
export function fmtSlippagePct(pct: number): string {
    const abs = Math.abs(pct);
    if (abs === 0 || abs >= 0.01) return `${pct.toFixed(2)}%`;
    return abs < 0.0005 ? `${pct < 0 ? "-" : ""}<0.001%` : `${pct.toFixed(3)}%`;
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

/**
 * What CLOSE & REVERSE does, in dollars at the expected fill: the position it
 * closes (with its P&L now) and the one it opens with the rest of the order.
 * "Closes your $1,000.00 LONG (+$12.50) and opens a $3,000.00 SHORT".
 */
export function flipSummary(p: {
    positionSide: "LONG" | "SHORT"; positionUsd: number; pnl: number;
    openSide: "LONG" | "SHORT"; openUsd: number;
}): string {
    return `Closes your ${fmtUsd(p.positionUsd)} ${p.positionSide} (${fmtSigned(p.pnl)}) and opens a ${fmtUsd(p.openUsd)} ${p.openSide}`;
}

/** A signed dollar estimate: "+$37.50", "-$37.50". */
function fmtSignedUsd(n: number): string {
    return `${n >= 0 ? "+" : "-"}${fmtUsd(Math.abs(n))}`;
}

function RefreshButton() {
    return (
        <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
                display: "block", marginTop: 6, padding: "4px 10px", fontSize: 10, letterSpacing: 2, fontFamily: "inherit",
                color: "#fff", background: "transparent", border: "1px solid rgba(255,255,255,0.35)", cursor: "pointer",
            }}
        >
            REFRESH
        </button>
    );
}

interface UnifiedOrderPanelProps {
    pair: TradingPair;
    position: Position | null;
    /** Every open position of the account this panel trades (for EQUITY). Defaults to `position`. */
    positions?: Position[];
    onOrderFilled: () => void;
}

export function UnifiedOrderPanel({
    pair,
    position,
    positions,
    onOrderFilled,
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
    // The book on screen. Every write below names it (see lib/orderScope).
    const scope = useOrderScope();
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
    const [btnState, setBtnState] = useState<"idle" | "success">("idle");
    // The last rejection, until the next edit (under the submit button).
    const [orderError, setOrderError] = useState<string | null>(null);
    const orderErrorRef = useRef<HTMLDivElement>(null);
    // A failed CLOSE or reverse (next to CLOSE).
    const [positionError, setPositionError] = useState<string | null>(null);
    const [closing, setClosing] = useState(false);
    const [reversing, setReversing] = useState(false);
    // A flip waits for a second, explicit click; so does the card's "reverse
    // to …". A reduce or close doesn't: getting out is one click.
    const [confirmReverse, setConfirmReverse] = useState(false);
    const [confirmCardReverse, setConfirmCardReverse] = useState(false);
    // A preset's solved size. The amount field shows its margin, but the order
    // sends this qty: amount / price would ignore the slippage the solve paid for.
    const [preset, setPreset] = useState<{ frac: number; budget: string; qty: string; notional: number } | null>(null);
    const presetRun = useRef(0);
    const [tpSlMsg, setTpSlMsg] = useState("");
    const [lastOrderUsd, setLastOrderUsd] = useState<number | null>(null);
    const [lastOrderFee, setLastOrderFee] = useState<number | null>(null);

    // Active triggers (shared with the Open Orders dock via the store)
    const activeTriggers = useTradingStore((s) => s.activeTriggers);
    const fetchTriggers = useTradingStore((s) => s.refreshTriggers);
    const updateTrigger = useTradingStore((s) => s.updateTrigger);
    const cancelTrigger = useTradingStore((s) => s.cancelTrigger);

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

    // Reset on pair or scope change: nothing typed for one book carries to another.
    useEffect(() => {
        setBtnState("idle");
        setOrderError(null);
        setPositionError(null);
        setPreset(null);
        setUsdAmount("");
        setTpPrice("");
        setSlPrice("");
        setTslOffset("");
        setTpSlMsg("");
        setConfirmReverse(false);
        setConfirmCardReverse(false);
    }, [selectedPairId, scope]);

    // The CONFIRM that sent a rejected order is pinned; the error may be off-screen.
    useEffect(() => {
        if (orderError) orderErrorRef.current?.scrollIntoView?.({ block: "nearest" });
    }, [orderError]);

    const [baseSymbol] = pair.symbol.split("/") as [string, string];
    // The snapshot-first ordering is load-bearing for replay mode:
    // onReplayTick writes snapshot but NOT pairPricesStore, so during a
    // replay session pairPrice holds the stale real-market value while
    // snapshot.last has the replay price. Do not "simplify" this ternary —
    // collapsing to pairPrice alone would break replay-mode pricing.
    const currentPrice = snapshot?.last
        ? parseFloat(snapshot.last)
        : pairPrice ?? 0;

    // An ISOLATED position is valued at the liquidation engine's mark (SSE
    // mark.price: the Kraken book mid liquidations are judged by), not the
    // last-trade ticker; flagged stale while the engine is paused on the pair
    // (lib/leverageUi positionMark). No engine mark yet: the ticker.
    const isIsolatedPosition = !!position && parseFloat(position.base_qty) !== 0 && position.margin_mode === "ISOLATED";
    const liqMark = useLiquidationMark(pair.id, currentPrice, isIsolatedPosition || leveraged);
    // A leveraged MARKET order previews (entry, notional, est. liq) at that
    // same mark; while it's stale, at the ticker with a STALE chip. Not
    // leveraged: the ticker, exactly as before.
    const marketPrice = leveraged && liqMark.source === "engine" && !liqMark.stale ? liqMark.mark : currentPrice;
    const previewStale = leveraged && orderType === "MARKET" && liqMark.stale;

    const effectivePrice =
        orderType === "LIMIT" && limitPrice ? parseFloat(limitPrice) : marketPrice;

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
    const effectiveUsd = preset ? preset.notional : preview ? preview.notional : usdNum;
    const baseQty = preset
        ? parseFloat(preset.qty)
        : preview
            ? (preview.qty ? parseFloat(preview.qty) : 0)
            : effectiveUsd > 0 && effectivePrice > 0 ? effectiveUsd / effectivePrice : 0;
    const baseQtyStr = preset ? preset.qty : preview ? preview.qty : baseQty > 0 ? baseQty.toFixed(8) : "";

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
    const engineMarks = useMarkPriceStore((s) => s.marks);
    // An ISOLATED position: margin, liq, health, P&L capped at the margin,
    // return on margin (lib/leverageUi). Health uses the pair's maintenance
    // margin from GET /leverage; until that arrives, the server's own figure.
    const isoView = isIsolatedPosition
        ? isolatedPositionView({
            baseQty: position!.base_qty,
            entry: position!.avg_entry_price,
            margin: position!.isolated_margin ?? "0",
            leverage: position!.leverage ?? "1",
            liqPrice: position!.liq_price ?? null,
            mmrBps: levInfo?.mmrBps ?? 0,
            mark: liqMark.mark,
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
    // accountEquity. Marks: the engine's where it has published one (the
    // selected pair's ISOLATED position as on its card), else the tick.
    const pairPrices = usePairPricesStore((s) => s.prices);
    const accountPositions = positions ?? (position ? [position] : []);
    const equity = leveraged && quoteWallet
        ? scopeEquity(parseFloat(quoteWallet.balance), accountPositions,
            (id) => (id === pair.id
                ? (isoView ? liqMark.mark : currentPrice)
                : engineMarks[id]?.mark ?? pairPrices[id] ?? null))
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

    // TP/SL/TSL of the open position: only triggers on the side that closes it.
    const positionTrigger = (kind: TriggerOrder["kind"]) =>
        activeTriggers.find((t) => t.kind === kind && t.side === (posQty > 0 ? "SELL" : "BUY"));
    const tpTrigger = positionTrigger("TAKE_PROFIT_MARKET");
    const slTrigger = positionTrigger("STOP_MARKET");
    const tslTrigger = positionTrigger("TRAILING_STOP_MARKET");

    // EST. LIQ PRICE with a position open is the POSITION's after this
    // order, not the order alone: an add books into one position (engine
    // math, lib/positionCard addPreview); a reduce leaves its liq price where
    // it is; a full close leaves none; a flip opens the rest on its own (the
    // order-alone preview). No position: the order alone, as before.
    const reverse = hasPosition && posDirection !== activeMode && baseQty > 0
        ? reverseSummary({ positionSide: posDirection!, positionQty: posAbsQty, orderQty: baseQty })
        : null;

    const reduces = reverse?.kind === "reduce" || reverse?.kind === "close";
    // A flip closes the position and opens only the rest of the order on the
    // other side: the TP/SL estimates and est. liq are about that resulting
    // position, not the whole order. (The order itself is unchanged.)
    const flip = reverse?.kind === "flip" ? reverse : null;
    const resultQty = flip ? flip.openQty : baseQty;
    const resultShare = flip && baseQty > 0 ? flip.openQty / baseQty : 1;
    // A TP/SL protects a position this order would open or grow; a reduce or
    // close opens nothing (the server refuses it too: trigger_not_reducing).
    // Hidden, not erased: typing a flip's size passes through reduce sizes.
    const tpShown = reduces ? "" : tpPrice;
    const slShown = reduces ? "" : slPrice;
    const tslShown = reduces ? "" : tslOffset;

    // TP/SL estimates
    const tpNum = tpShown ? parseFloat(tpShown) : 0;
    const slNum = slShown ? parseFloat(slShown) : 0;
    const tslNum = tslShown ? parseFloat(tslShown) : 0;
    const tpEstProfit = tpNum > 0 && resultQty > 0
        ? (activeMode === "LONG" ? (tpNum - effectivePrice) : (effectivePrice - tpNum)) * resultQty
        : 0;
    const slEstLoss = slNum > 0 && resultQty > 0
        ? (activeMode === "LONG" ? (slNum - effectivePrice) : (effectivePrice - slNum)) * resultQty
        : 0;
    const resultMargin = usdNum * resultShare;
    const tpEstPct = resultMargin > 0 && tpEstProfit !== 0 ? (tpEstProfit / resultMargin) * 100 : 0;  // % of margin
    const slEstPct = resultMargin > 0 && slEstLoss !== 0 ? (slEstLoss / resultMargin) * 100 : 0;

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
    const tslError = trailingOffsetError(tslShown, currentPrice, slDistance);
    const hasValidationError = !!(tpError || slError || tslError);

    const limitWarn = orderType === "LIMIT" && limitPrice
        ? (activeMode === "LONG" && parseFloat(limitPrice) > currentPrice
            ? "Price above market — will fill immediately"
            : activeMode === "SHORT" && parseFloat(limitPrice) < currentPrice
                ? "Price below market — will fill immediately"
                : null)
        : null;

    // ── MARKET preview: the quote. Until the first answer, the local estimate
    // (dimmed); on failure "—", never the last number. ──
    const sideParam = activeMode === "LONG" ? "BUY" : "SELL";
    const quoting = orderType === "MARKET" && usdNum > 0;
    const confirmingFlip = confirmReverse && reverse?.kind === "flip";
    const qtyRef = useRef(baseQtyStr);
    qtyRef.current = baseQtyStr;
    const { quotes, loading: quoteLoading } = useMarketQuotes(
        quoting ? `${pair.id}:${activeMode}:${usdAmount}:${leverage}:${preset?.qty ?? ""}:${reduces}` : null,
        () => (qtyRef.current
            ? [{ pairId: pair.id, side: sideParam, qty: qtyRef.current, ...(reduces ? { reduces } : {}) }]
            : []),
        QUOTE_REFRESH_MS,
    );
    const answer = quoting && quotes ? quotes[0] ?? null : undefined;  // undefined = none yet
    const quote = answer?.executable ? answer : null;
    const quoteDash = quoting && answer !== undefined && !quote;
    const dim = quoting && quoteLoading ? DIM : undefined;

    const errorContext: OrderErrorContext = {
        leveraged, cap: levCap, available: quoteBalance, baseSymbol,
        maxNotional: pair.max_order_notional ? Number(pair.max_order_notional) : null,
    };
    const quoteHint = answer && !answer.executable ? quoteReasonText(answer.reason, errorContext) : null;

    const estFill = quoteDash ? null : quote ? parseFloat(quote.estimatedPrice) : effectivePrice;
    const shownNotional = quote ? parseFloat(quote.requestedNotional) : effectiveUsd;
    const shownFee = quote ? parseFloat(quote.feeQuote) : estFee;
    const slipPct = quote ? parseFloat(quote.slippage_bps) / 100 : null;
    const slipUsd = quote ? parseFloat(quote.slippageQuote) : 0;

    // What the engine will draw: margin on the notional at the fill, plus the
    // fee. Only an order that opens or adds: a reduce or close frees margin, a
    // flip frees it first. A warning, not a block: the server has the final say.
    const orderCost = shownNotional / leverage + shownFee;
    const short = available !== null && !reverse && usdNum > 0 && orderCost > quoteBalance;
    const balanceWarning = short && !quoteHint ? `Not enough available: need ${fmtUsd(orderCost)} incl. fee — use MAX` : null;

    const newLiq = () => estLiqPrice({
        side: activeMode, qty: flip ? flip.openQty.toFixed(8) : baseQtyStr, entry: estFill ?? 0, leverage, mmrBps: levInfo?.mmrBps ?? 0,
    });
    // The flip in dollars at the expected fill (the ticker until a quote lands).
    const flipPrice = estFill ?? effectivePrice;
    const flipText = flip && hasPosition
        ? flipSummary({
            positionSide: posDirection!, positionUsd: posAbsQty * flipPrice, pnl: pnlValue,
            openSide: flip.openSide, openUsd: flip.openQty * flipPrice,
        })
        : null;
    const estLiq: { price: number | null; note: string } | null = (() => {
        if (!preview || !baseQtyStr) return null;
        if (!isoView) return { price: newLiq(), note: "this order" };
        if (posDirection === activeMode) {
            const after = addPreview(
                { baseQty: position!.base_qty, entry: position!.avg_entry_price, margin: position!.isolated_margin ?? "0",
                  leverage: position!.leverage ?? "1", mmrBps: levInfo?.mmrBps ?? 0 },
                baseQtyStr, estFill ?? effectivePrice,
            );
            return after ? { price: after.liqPrice ? after.liqPrice.toNumber() : null, note: "your position after this add" } : null;
        }
        if (reverse?.kind === "reduce") return { price: isoView.liqPrice, note: "your position after this reduce" };
        if (reverse?.kind === "close") return { price: null, note: "this closes the position" };
        return { price: newLiq(), note: `the ${activeMode} this opens` };
    })();

    /** Any change to the order: the rejection and the confirm were for the old one. */
    const onEdit = useCallback(() => {
        setOrderError(null);
        setPositionError(null);
        setConfirmReverse(false);
        setConfirmCardReverse(false);
    }, []);
    /** The same, for a change a preset's solved size doesn't survive. */
    const onResize = useCallback(() => {
        onEdit();
        presetRun.current += 1;
        setPreset(null);
    }, [onEdit]);

    // The confirms are for this position: none survive it.
    useEffect(() => {
        if (hasPosition) return;
        setConfirmCardReverse(false);
        setPositionError(null);
    }, [hasPosition]);

    // Sync direction → store orderSide
    const handleModeChange = useCallback((mode: "LONG" | "SHORT") => {
        setActiveMode(mode);
        onResize();
        setOrderSide(mode === "LONG" ? "BUY" : "SELL");
    }, [setOrderSide, onResize]);

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
        if (hasPosition && posDirection === activeMode) return `ADD TO ${activeMode}`;
        if (reverse?.kind === "flip") return "CLOSE & REVERSE";
        if (reverse?.kind === "close") return "CLOSE";
        if (hasPosition) return `REDUCE ${posDirection}`;
        return openButtonLabel({
            mode: isLong ? "LONG" : "SHORT",
            baseQty, effectiveUsd, baseSymbol, fmtUsd,
        });
    })();
    // The enriched OPEN label (with notional + qty) is the only long one — let it
    // wrap/shrink so it never clips at a narrow panel width.
    const btnLabelEnriched =
        !orderSubmitting && btnState === "idle" && !hasPosition && baseQty > 0;

    const handlePlaceOrder = async () => {
        if (!appInitialized || !marketReady || !baseQtyStr) return;
        // A flip: say what it does, then wait for CONFIRM. Never one click.
        if (reverse?.kind === "flip" && !confirmReverse) {
            setConfirmCardReverse(false);
            setConfirmReverse(true);
            return;
        }
        setConfirmReverse(false);
        setOrderError(null);
        setTpSlMsg("");
        setBtnState("idle");
        // An order's TP/SL go with it, even if the switch moves while it's in flight.
        const orderScope = scope;
        try {
            // A preset, solved again now: the book may have moved since its
            // click, past what the solve's drift buffer covers.
            let solvedQty: string | undefined;
            if (preset && orderType === "MARKET") {
                const fresh = await getMarketQuote(budgetParams(preset.budget)).then((r) => r.data).catch(() => null);
                if (fresh && !(fresh.executable && parseFloat(fresh.qty) > 0)) {
                    setOrderError(quoteReasonText(fresh.reason, errorContext));
                    return;
                }
                solvedQty = fresh?.qty ?? preset.qty;
            }
            // `leverage` only for a leveraged order, `qty` only for a preset,
            // `reduceOnly` only for a reduce or close, MARKET or LIMIT (a
            // resting LIMIT close then never opens the other side if the
            // position shrinks first): otherwise the body is the pre-leverage one.
            const opts = {
                scope: orderScope,
                ...(leveraged ? { leverage } : {}),
                ...(solvedQty ? { qty: solvedQty } : {}),
                ...(reduces ? { reduceOnly: true } : {}),
            };
            const result = await submitOrder(opts);
            const fills = result?.fills ?? [];
            const filledQty = fills.reduce((sum: number, f: { qty: string }) => sum + parseFloat(f.qty), 0);

            // Create TP/SL triggers if specified and order filled
            if (filledQty > 0 && selectedPairId && !reduces) {
                const closeSide = (isLong ? "SELL" : "BUY") as "BUY" | "SELL";
                try {
                    if (tpNum && slNum && tpValid && slValid) {
                        await createOco({
                            scope: orderScope,
                            pairId: selectedPairId,
                            legA: { kind: "STOP_MARKET", side: closeSide, triggerPrice: slPrice },
                            legB: { kind: "TAKE_PROFIT_MARKET", side: closeSide, triggerPrice: tpPrice },
                        });
                        setTpSlMsg("ORDER + TP/SL SET");
                    } else if (tpNum && tpValid) {
                        await createTrigger({
                            scope: orderScope,
                            pairId: selectedPairId,
                            kind: "TAKE_PROFIT_MARKET",
                            side: closeSide,
                            triggerPrice: tpPrice,
                        });
                        setTpSlMsg("ORDER + TP SET");
                    } else if (slNum && slValid) {
                        await createTrigger({
                            scope: orderScope,
                            pairId: selectedPairId,
                            kind: "STOP_MARKET",
                            side: closeSide,
                            triggerPrice: slPrice,
                        });
                        setTpSlMsg("ORDER + SL SET");
                    }

                    // Create trailing stop if specified
                    if (tslNum > 0) {
                        const initialStop = isLong
                            ? (currentPrice - tslNum).toFixed(8)
                            : (currentPrice + tslNum).toFixed(8);
                        await createTrigger({
                            scope: orderScope,
                            pairId: selectedPairId,
                            kind: "TRAILING_STOP_MARKET",
                            side: closeSide,
                            triggerPrice: initialStop,
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
            setLastOrderUsd(shownNotional);
            setLastOrderFee(shownFee);
            setPreset(null);
            setUsdAmount("");
            setTpPrice("");
            setSlPrice("");
            setTslOffset("");
            onOrderFilled();
            fetchTriggers();
            setTimeout(() => { setBtnState("idle"); setTpSlMsg(""); }, 2500);
        } catch (err) {
            setOrderError(orderErrorText(err, errorContext));
            // The position this order was for is gone: drop the stale card.
            if ((err as AxiosError<{ error?: string }>).response?.data?.error === "reduce_only_no_position") {
                onOrderFilled();
                fetchTriggers();
            }
        }
    };

    const handleClosePosition = async () => {
        if (!hasPosition || !selectedPairId) return;
        setClosing(true);
        setPositionError(null);
        try {
            const closeSide = posQty > 0 ? "SELL" : "BUY";
            // Reduce-only: if the position is already gone (liquidated, a
            // stop fired, the match ended) or smaller, the server trims or
            // rejects it — a CLOSE can never open a new position.
            await placeOrder(
                { scope, pairId: selectedPairId, side: closeSide, type: "MARKET", qty: posAbsQty.toFixed(8), reduceOnly: true },
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
                setPositionError(orderErrorText(err, errorContext));
            }
        } finally {
            setClosing(false);
        }
    };

    /** The card's error text for a failed trigger call. */
    const triggerError = (err: unknown, fallback: string) => {
        const data = (err as AxiosError<{ message?: string; error?: string }>).response?.data;
        return data?.message ?? fallback;
    };

    const handleEditTrigger = async (oldTrigger: TriggerOrder, newPrice: string): Promise<string | null> => {
        // One atomic PATCH: the trigger keeps its id and OCO link (the old
        // cancel-then-create orphaned the other leg). On failure the old
        // trigger is untouched, so just say so and keep the edit open.
        try {
            await updateTrigger(oldTrigger.id, { triggerPrice: newPrice });
            return null;
        } catch (err) {
            return triggerError(err, "Couldn't update trigger — the old one is still active. Try again.");
        }
    };

    /** A TP or SL on the whole open position (reduce-only on the server). */
    const handleSetTrigger = async (kind: "TAKE_PROFIT_MARKET" | "STOP_MARKET", price: string): Promise<string | null> => {
        if (!hasPosition || !selectedPairId) return "No open position";
        try {
            await createTrigger({
                scope, pairId: selectedPairId, kind, side: posQty > 0 ? "SELL" : "BUY",
                triggerPrice: price,
            });
            await fetchTriggers();
            return null;
        } catch (err) {
            return triggerError(err, kind === "TAKE_PROFIT_MARKET" ? "Couldn't set the take profit" : "Couldn't set the stop loss");
        }
    };

    const handleRemoveTrigger = async (t: TriggerOrder): Promise<string | null> => {
        try {
            await cancelTrigger(t.id);
            return null;
        } catch (err) {
            return triggerError(err, "Couldn't remove it. Try again.");
        }
    };

    /**
     * The card's "reverse to …": one MARKET order of twice the size on the
     * other side, so the close and the new position fill together. Leveraged,
     * at the position's leverage (the new side opens from flat with it).
     */
    const handleReverse = async () => {
        if (!hasPosition || !selectedPairId) return;
        setReversing(true);
        setPositionError(null);
        try {
            await placeOrder(
                {
                    scope, pairId: selectedPairId, side: posQty > 0 ? "SELL" : "BUY", type: "MARKET",
                    qty: (posAbsQty * 2).toFixed(8),
                    ...(leveraged && isoView ? { leverage: isoView.leverage } : {}),
                },
                crypto.randomUUID(),
            );
            onOrderFilled();
            fetchTriggers();
        } catch (err) {
            setPositionError(orderErrorText(err, errorContext));
        } finally {
            setReversing(false);
        }
    };

    // ── 25/50/75/MAX: a share of what's free, solved by the server so the
    // order fits with its margin, fee, slippage and drift, under the pair's
    // max. MARKET asks the quote; a LIMIT knows its price, so it's arithmetic. ──
    const budgetParams = (budget: string): QuoteParams => ({
        pairId: pair.id, side: sideParam, budget, ...(leveraged ? { leverage } : {}),
    });
    const budgetFor = (frac: number) => computeQuickAmount(quoteBalance, frac).toFixed(8);
    // Keyed on 3 significant figures: buying power moves with every tick while
    // a short is open, and a chip only needs to be close (a click solves anew).
    const { quotes: presetQuotes } = useMarketQuotes(
        orderType === "MARKET" && quoteBalance > 0 ? `${pair.id}:${activeMode}:${leverage}:${quoteBalance.toPrecision(3)}` : null,
        () => PRESETS.map((frac) => budgetParams(budgetFor(frac))),
    );
    /** A LIMIT preset's margin: fee at the higher rate (the engine reserves that), under the cap. */
    const limitAmount = (frac: number) => {
        const pool = maxMargin(quoteBalance, leverage, Math.max(pair.taker_fee_bps, pair.maker_fee_bps));
        const cap = errorContext.maxNotional;
        return Math.min(computeQuickAmount(pool, frac), cap !== null ? Math.floor(cap / leverage) : Infinity);
    };
    const presetNotional = (frac: number, i: number): number | null => {
        if (orderType === "LIMIT") return limitAmount(frac) * leverage;
        const q = presetQuotes?.[i];
        return q?.executable ? parseFloat(q.requestedNotional) : null;
    };

    const pickPreset = async (frac: number) => {
        onResize();
        setLastOrderUsd(null);
        setLastOrderFee(null);
        if (orderType === "LIMIT") {
            const v = limitAmount(frac);
            if (v > 0) setUsdAmount(v + "");
            return;
        }
        const run = presetRun.current;
        const budget = budgetFor(frac);
        try {
            const q = (await getMarketQuote(budgetParams(budget))).data;
            if (run !== presetRun.current) return;
            if (!q.executable || !(parseFloat(q.qty) > 0)) {
                setOrderError(quoteReasonText(q.reason, errorContext));
                return;
            }
            const notional = parseFloat(q.requestedNotional);
            setPreset({ frac, budget, qty: q.qty, notional });
            setUsdAmount(computeQuickAmount(notional / leverage, 1) + "");
        } catch {
            if (run === presetRun.current) setOrderError("Couldn't size the order — retry");
        }
    };

    /** Arrow keys walk the leverage group (one tab stop, like any radio group). */
    const onLeverageKey = (e: React.KeyboardEvent<HTMLButtonElement>, lv: number) => {
        const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!step || lockedLeverage !== null) return;
        e.preventDefault();
        const next = levOptions[(levOptions.indexOf(lv) + step + levOptions.length) % levOptions.length]!;
        onResize();
        setLeverage(next);
        const group = e.currentTarget.parentElement;
        group?.querySelector<HTMLButtonElement>(`[data-lv="${next}"]`)?.focus();
    };

    const btnClass = (() => {
        if (btnState === "success") return `tr-place-btn success`;
        return `tr-place-btn ${isLong ? "buy" : "sell"}`;
    })();

    return (
        <div className={`tr-order-section`}>
            {/* The form scrolls on its own, above the action bar. */}
            <div className={`tr-order-form`}>
            {/* ── OPEN POSITION CARD — first in the panel, above LONG/SHORT, so
                it's visible without scrolling; the form follows in normal flow. ── */}
            {hasPosition && (
                <PositionCard
                    key={`${pair.id}:${cardKey}`}
                    pair={pair}
                    baseSymbol={baseSymbol}
                    position={position!}
                    direction={posDirection!}
                    qty={posAbsQty}
                    entry={posEntryPrice}
                    mark={isoView ? liqMark.mark : currentPrice}
                    markStale={!!isoView && liqMark.stale}
                    isoView={isoView}
                    health={isoHealth}
                    mmrBps={levInfo?.mmrBps ?? 0}
                    pnl={pnlValue}
                    pnlPct={pnlPct}
                    pnlFlash={pnlFlash}
                    entering={cardEntering}
                    tpTrigger={tpTrigger}
                    slTrigger={slTrigger}
                    tslTrigger={tslTrigger}
                    onSetTrigger={handleSetTrigger}
                    onEditTrigger={handleEditTrigger}
                    onRemoveTrigger={handleRemoveTrigger}
                    reversing={reversing}
                    onReverse={() => { onEdit(); setConfirmCardReverse(true); }}
                />
            )}

            {/* ── DIRECTION ── */}
            <div className={`tr-dir-toggle`}>
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

            {/* ── ORDER TYPE ── */}
            <div className={`tr-type-toggle`}>
                {(["MARKET", "LIMIT"] as const).map((t) => (
                    <div
                        key={t}
                        className={`tr-tt${orderType === t ? " active" : ""}`}
                        onClick={() => {
                            onResize();
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
                        <button
                            key={lv}
                            type="button"
                            role="radio"
                            data-lv={lv}
                            aria-label={`${lv}x leverage`}
                            aria-checked={selected}
                            disabled={locked}
                            tabIndex={selected ? 0 : -1}
                            onClick={() => { if (lockedLeverage === null) { onResize(); setLeverage(lv); } }}
                            onKeyDown={(e) => onLeverageKey(e, lv)}
                            style={{
                                flex: 1, textAlign: "center", padding: "5px 0",
                                fontSize: 10, letterSpacing: 1, fontFamily: "inherit",
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
                        </button>
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
                height; in MARKET mode only AMOUNT is present and it stays full-width. */}
            <div className={`tr-pa-row`}>
            {/* ── LIMIT PRICE ── */}
            {orderType === "LIMIT" && (
                <div className={`tr-field`}>
                    <label>LIMIT PRICE</label>
                    <div className={`tr-field-wrap`}>
                        <input type="number" placeholder={currentPrice ? currentPrice.toFixed(2) : "0.00"} value={limitPrice} onChange={(e) => { onEdit(); setLimitPrice(e.target.value); }} />
                        <span className={`tr-field-unit`}>USD</span>
                    </div>
                    {limitWarn && <div style={{ fontSize: 9, color: "#f59e0b", marginTop: 4, letterSpacing: 1 }}>{limitWarn}</div>}
                </div>
            )}

            {/* ── AMOUNT (USD) ── */}
            <div className={`tr-field`}>
                <label>{leveraged ? "MARGIN" : "AMOUNT"}</label>
                <div className={`tr-field-wrap`}>
                    <input type="number" placeholder="0.00" value={usdAmount} onChange={(e) => { onResize(); setUsdAmount(e.target.value); setLastOrderUsd(null); setLastOrderFee(null); }} />
                    <span className={`tr-field-unit`}>USD</span>
                </div>
                {baseQty > 0 && <div style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", marginTop: 3, letterSpacing: 1 }}>
                    ≈ {baseQty.toFixed(4)} {baseSymbol}{leveraged && ` · ${fmtUsd(effectiveUsd)} at ${leverage}x`}
                </div>}
            </div>
            </div>{/* /tr-pa-row */}

            {/* 25/50/75/MAX: their own row, full width even beside LIMIT PRICE,
                and outside the <label> (a click on it would press the first chip). */}
            <div role="group" aria-label="Order size presets" style={{ display: "flex", gap: 4, marginBottom: 10 }}>
                {PRESETS.map((frac, i) => {
                    const name = frac === 1 ? "MAX" : `${frac * 100}%`;
                    const notional = presetNotional(frac, i);
                    return (
                        <button
                            key={frac}
                            type="button"
                            disabled={!(quoteBalance > 0)}
                            aria-pressed={preset?.frac === frac}
                            aria-label={`${name}: use ${frac === 1 ? "all" : name + " of"} available${notional ? `, about ${fmtUsd(notional)} notional` : ""}`}
                            onClick={() => { void pickPreset(frac); }}
                            style={{
                                flex: 1, minWidth: 0, padding: "3px 0", fontSize: 9, letterSpacing: 0.5, fontFamily: "inherit", whiteSpace: "nowrap",
                                color: "var(--ar-orange, var(--g, #00ff41))", background: "transparent",
                                border: `1px solid ${preset?.frac === frac ? "var(--ar-orange, var(--g, #00ff41))" : "rgba(255,255,255,0.08)"}`,
                                cursor: quoteBalance > 0 ? "pointer" : "default",
                                opacity: quoteBalance > 0 ? 1 : 0.4,
                            }}
                        >
                            {name}{notional ? ` · ${fmtCompactUsd(notional)}` : ""}
                        </button>
                    );
                })}
            </div>

            {/* TAKE PROFIT + STOP LOSS share one 2-col row (same :has() mechanism as
                the LIMIT PRICE|AMOUNT tr-pa-row). Pairing the two stacked fields into
                one row reclaims a full field's vertical height (~77px) — exactly what
                TRAILING STOP needs to stay above the pinned footer in the worst-case
                filled state (PR #50). Each column is self-contained (label + input +
                its OWN helper), and the grid's align-items:start keeps both inputs
                top-aligned even when only one column shows a helper. */}
            <div className={`tr-ts-row`}>
            {/* ── TAKE PROFIT ── */}
            <div className={`tr-field`}>
                <label>TAKE PROFIT</label>
                <div className={`tr-field-wrap`}>
                    <input type="number" disabled={reduces} placeholder={isLong ? "above entry" : "below entry"} value={tpShown} onChange={(e) => { onEdit(); setTpPrice(e.target.value); }} />
                    <span className={`tr-field-unit`}>USD</span>
                </div>
                {tpError && <div style={{ fontSize: 9, color: "#ff3b3b", marginTop: 3 }}>{tpError}</div>}
                {!tpError && tpNum > 0 && tpEstProfit !== 0 && <div style={{ fontSize: 9, color: tpEstProfit > 0 ? "#00ff41" : "#ff3b3b", marginTop: 3 }}>Est. profit: {fmtSignedUsd(tpEstProfit)} ({tpEstPct >= 0 ? "+" : ""}{tpEstPct.toFixed(1)}%)</div>}
            </div>

            {/* ── STOP LOSS ── */}
            <div className={`tr-field`}>
                <label>STOP LOSS</label>
                <div className={`tr-field-wrap`}>
                    <input type="number" disabled={reduces} placeholder={isLong ? "below entry" : "above entry"} value={slShown} onChange={(e) => { onEdit(); setSlPrice(e.target.value); }} />
                    <span className={`tr-field-unit`}>USD</span>
                </div>
                {slError && <div style={{ fontSize: 9, color: "#ff3b3b", marginTop: 3 }}>{slError}</div>}
                {!slError && slNum > 0 && slEstLoss !== 0 && <div style={{ fontSize: 9, color: slEstLoss < 0 ? "#ff3b3b" : "#00ff41", marginTop: 3 }}>Est. loss: {fmtSignedUsd(slEstLoss)} ({slEstPct >= 0 ? "+" : ""}{slEstPct.toFixed(1)}%)</div>}
            </div>
            </div>{/* /tr-ts-row */}

            {/* ── TRAILING STOP ── */}
            <div className={`tr-field`}>
                <label>TRAILING STOP</label>
                <div className={`tr-field-wrap`}>
                    <input type="number" disabled={reduces} placeholder="offset in USD" value={tslShown} onChange={(e) => { onEdit(); setTslOffset(e.target.value); }} />
                    <span className={`tr-field-unit`}>USD</span>
                </div>
                {tslError && <div style={{ fontSize: 9, color: "#ff3b3b", marginTop: 3 }}>{tslError}</div>}
                {!tslError && tslNum > 0 && currentPrice > 0 && (
                    <div style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", marginTop: 3 }}>
                        Stops at {fmtUsd(isLong ? currentPrice - tslNum : currentPrice + tslNum)} if price stays at current level
                    </div>
                )}
            </div>

            {reduces && (
                <div data-testid="tpsl-reduce-hint" style={{ fontSize: 9, lineHeight: 1.4, color: "rgba(255,255,255,0.45)", marginBottom: 8, letterSpacing: 1 }}>
                    This order only reduces your {posDirection}, so it can't carry a TP or SL. Set them on the position card.
                </div>
            )}

            {/* Footer. No open position (trade page): pinned, so the cost summary +
                submit button stay visible while TP/SL/TSL scroll above. With a position open: in normal flow (-with-position) and
                the card sits at the top of the panel instead. Pinned with the card, the
                group covered the form above it (MARKET/LIMIT clipped). */}
            <div className={`tr-order-footer${hasPosition ? ` tr-order-footer-with-position` : ` tr-order-footer-pinned`}`}>
            {/* ── SUMMARY ── */}
            {flipText && (
                <div data-testid="flip-summary" style={{ fontSize: 10, lineHeight: 1.4, color: "#f59e0b", marginBottom: 6, letterSpacing: 0.5 }}>
                    {flipText}
                </div>
            )}
            <div className={`tr-summary`}>
                <div className={`tr-sum-row`}>
                    <span className={`tr-sum-lbl`} title={PRICE_HELP.estFill}>EST. FILL</span>
                    <span className={`tr-sum-val`} style={{ ...dim, ...(previewStale ? { color: "#f59e0b" } : undefined) }}>
                        {quoteDash ? "—" : quoting || (orderType === "LIMIT" && limitPrice) ? fmtUsd(estFill ?? 0) : <span className={`tr-sum-empty`}>--</span>}
                    </span>
                </div>
                {/* Its own row: a chip beside the price overflows the cell at panel width. */}
                {previewStale && (
                    <div className={`tr-sum-row`}>
                        <span className={`tr-sum-lbl`}>PRICE FEED</span>
                        <span className={`tr-sum-val`}>
                            <span
                                title="Price feed stale: liquidations are paused on this pair. Previewing at the last trade."
                                style={{ padding: "0 3px", fontSize: 8, letterSpacing: 1, color: "#f59e0b", border: "1px solid rgba(245,158,11,0.5)" }}
                            >
                                STALE
                            </span>
                        </span>
                    </div>
                )}
                <div className={`tr-sum-row`}>
                    <span className={`tr-sum-lbl`} title={flip ? "The position this leaves you: the order less what closes the current one" : undefined}>
                        {flip ? "NEW POSITION" : leveraged ? "NOTIONAL" : "POSITION SIZE"}
                    </span>
                    <span className={`tr-sum-val`} style={dim}>{quoteDash ? "—" : shownNotional > 0 ? fmtUsd(shownNotional * resultShare) : lastOrderUsd ? fmtUsd(lastOrderUsd) : <span className={`tr-sum-empty`}>--</span>}</span>
                </div>
                {orderType === "MARKET" && (
                    <div className={`tr-sum-row tr-sum-wide`}>
                        <span className={`tr-sum-lbl`} title="Est. fill vs the best bid / ask, for this size">SLIPPAGE</span>
                        <span className={`tr-sum-val`} style={dim}>
                            {quoteDash ? "—" : slipPct !== null ? `${fmtSlippagePct(slipPct)} · ${slipUsd < 0 ? "-" : ""}${fmtUsd(Math.abs(slipUsd))}` : <span className={`tr-sum-empty`}>--</span>}
                        </span>
                    </div>
                )}
                <div className={`tr-sum-row`}>
                    <span className={`tr-sum-lbl`} title={flip ? "The whole order's fee: closing the current position and opening the new one" : undefined}>
                        {flip ? `${feeLabel} · BOTH LEGS` : feeLabel}
                    </span>
                    <span className={`tr-sum-val`} style={dim}>{quoteDash ? "—" : shownFee > 0 ? fmtFee(shownFee) : lastOrderFee ? fmtFee(lastOrderFee) : <span className={`tr-sum-empty`}>--</span>}</span>
                </div>
                {leveraged && (
                    <div className={`tr-sum-row`}>
                        <span className={`tr-sum-lbl`}>EST. LIQ PRICE</span>
                        <span
                            className={`tr-sum-val`}
                            data-testid="est-liq"
                            style={{ ...dim, color: estLiq?.price ? "#f59e0b" : undefined }}
                            title={!estLiq
                                ? undefined
                                : estLiq.price !== null && estFill
                                    ? `Liquidation at ${fmtUsd(estLiq.price)} (${estLiq.price >= estFill ? "+" : ""}${((estLiq.price / estFill - 1) * 100).toFixed(1)}% from entry) for ${estLiq.note}: the margin, less the maintenance margin, used up`
                                    : reverse?.kind === "close" ? "This closes the position" : "A 1x long can't be liquidated"}
                        >
                            {quoteDash && reverse?.kind !== "reduce" ? "—"
                                : estLiq?.price ? fmtUsd(estLiq.price)
                                : estLiq && reverse?.kind === "close" ? "—"
                                : usdNum > 0 ? "None" : <span className={`tr-sum-empty`}>--</span>}
                        </span>
                    </div>
                )}
                <div className={`tr-sum-row`}>
                    <span className={`tr-sum-lbl`} style={{ color: "rgba(255,255,255,0.35)" }}>AVAILABLE</span>
                    <span
                        className={`tr-sum-val`}
                        style={{ color: available !== null && available < 0 ? "#ff3b3b" : "#fff" }}
                        title={leveraged ? "Free USD: your balance minus what open orders hold. Open positions' margin is already out of it." : "Cash minus what open shorts hold (2× their value)"}
                    >
                        {available === null ? "—" : `${available < 0 ? "-" : ""}$${formatDecimal(Math.abs(available).toString(), 2)} USD`}
                    </span>
                </div>
                {leveraged && (
                    <div className={`tr-sum-row`}>
                        <span className={`tr-sum-lbl`}>EQUITY</span>
                        <span className={`tr-sum-val`} title="USD plus each open position's margin and P&L (a loss counts at most its margin)">
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
            {!confirmingFlip && (
            <button
                className={btnClass}
                style={{
                    ...(btnLabelEnriched ? { letterSpacing: 1, fontSize: 11, whiteSpace: "normal", lineHeight: 1.3 } : undefined),
                    ...(balanceWarning ? { opacity: 0.55 } : undefined),
                }}
                disabled={orderSubmitting || !usdAmount || usdNum <= 0 || !appInitialized || !marketReady || hasValidationError}
                onClick={handlePlaceOrder}
            >
                {btnLabel}
            </button>
            )}
            {orderError ? (
                <div ref={orderErrorRef} role="alert" data-testid="order-error"
                    style={{ fontSize: 10, lineHeight: 1.4, color: "#ff3b3b", marginTop: 6, scrollMarginBottom: 120 }}>
                    {orderError}
                    {orderError === CLIENT_OUTDATED && <RefreshButton />}
                </div>
            ) : (quoteHint || balanceWarning) && (
                <div data-testid={quoteHint ? "quote-hint" : "balance-warning"} style={{ fontSize: 10, lineHeight: 1.4, color: "#f59e0b", marginTop: 6 }}>
                    {quoteHint ?? balanceWarning}
                </div>
            )}

            </div>{/* /order-footer */}
            </div>{/* /tr-order-form */}

            {/* ── Pinned actions ── (see .tr-pos-actions) */}
            {hasPosition && (
                <div className={`tr-pos-actions`} data-testid="position-actions">
                    {confirmingFlip && (
                        <ConfirmBox
                            message={`${flipText}. Confirm?`}
                            confirmLabel="CONFIRM"
                            busy={orderSubmitting}
                            onConfirm={() => { void handlePlaceOrder(); }}
                            onCancel={() => setConfirmReverse(false)}
                        />
                    )}
                    {confirmCardReverse && (
                        <ConfirmBox
                            message={`This closes your ${posDirection} (${fmtSigned(pnlValue)}) and opens a ${posDirection === "LONG" ? "SHORT" : "LONG"} of ${fmtQty(posAbsQty)} ${baseSymbol}. Confirm?`}
                            confirmLabel={`REVERSE TO ${posDirection === "LONG" ? "SHORT" : "LONG"}`}
                            busy={reversing}
                            onConfirm={() => { setConfirmCardReverse(false); void handleReverse(); }}
                            onCancel={() => setConfirmCardReverse(false)}
                        />
                    )}
                    {positionError && (
                        <div role="alert" style={{ fontSize: 10, lineHeight: 1.4, color: "#ff3b3b", marginBottom: 6 }}>
                            {positionError}
                            {positionError === CLIENT_OUTDATED && <RefreshButton />}
                        </div>
                    )}
                    <button
                        type="button"
                        disabled={closing}
                        onClick={() => { void handleClosePosition(); }}
                        style={{
                            width: "100%", padding: "10px 0", marginTop: confirmingFlip || confirmCardReverse ? 6 : 0,
                            background: "rgba(255,59,59,0.18)", border: "1px solid rgba(255,59,59,0.55)",
                            color: "#ff3b3b", fontSize: 11, fontWeight: 700, letterSpacing: 3,
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
