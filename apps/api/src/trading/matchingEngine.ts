/**
 * Matching Engine — core order placement and cancellation logic.
 *
 * ════════════════════════════════════════════════════════════════════
 * TRANSACTION ISOLATION & LOCKING STRATEGY
 * ════════════════════════════════════════════════════════════════════
 *
 * Every placeOrder / cancelOrder call runs inside a single PostgreSQL
 * transaction.  Two levels of row-level locks provide isolation:
 *
 *   Level 1 — Pair lock  (`SELECT ... FOR UPDATE` on `trading_pairs`)
 *     Acquired first in every transaction.  Serializes all matching
 *     and cancel activity for a given pair, preventing two transactions
 *     from reading the same resting order simultaneously.  Different
 *     pairs are fully independent and never contend.
 *
 *   Level 2 — Wallet locks  (`SELECT ... FOR UPDATE` on `wallets`)
 *     Acquired after the pair lock and always in deterministic UUID
 *     sort order.  Prevents balance races when multiple fills touch
 *     the same wallet (e.g. a maker with orders in several pairs).
 *
 * ── Deadlock prevention ──────────────────────────────────────────
 *
 * Deadlocks are prevented by a strict lock acquisition order:
 *
 *   1. Pair lock first   — one row per transaction, so no cycle is
 *      possible between pairs.  All participants in a given pair
 *      queue on the same row.
 *
 *   2. Wallet locks second — sorted by wallet UUID (ascending).
 *      Two transactions that need the same set of wallets will
 *      acquire them in the same order, satisfying the classic
 *      ordered-resource deadlock-avoidance invariant.
 *
 * Because Level 1 fully serializes per-pair matching, Level 2 only
 * comes into play for cross-pair contention on shared wallets —
 * and the sort order guarantees those locks are also deadlock-free.
 *
 * ── Future: narrowing the pair lock ──────────────────────────────
 *
 * The pair-level `FOR UPDATE` lock is a coarse serialization point:
 * it means only one order per pair can match at a time.  This is
 * correct and simple but limits throughput for high-volume pairs.
 *
 * Possible narrower strategies (analysis only — not implemented):
 *
 *   • Advisory locks per price level — `pg_advisory_xact_lock(pair_id,
 *     price_bucket)` would allow concurrent matching at non-overlapping
 *     price levels.  Risk: two MARKET orders may still compete for the
 *     same best-price resting order, so the innermost fill loop would
 *     need `FOR UPDATE SKIP LOCKED` or optimistic-retry semantics.
 *
 *   • Row-level `FOR UPDATE SKIP LOCKED` on individual resting orders
 *     — each matcher locks only the rows it fills.  Highly concurrent,
 *     but requires careful handling of partial batches and retry on
 *     skipped rows to preserve price-time priority.
 *
 * Both alternatives add complexity.  The current pair lock is the
 * right choice until benchmarking shows per-pair throughput is a
 * bottleneck (hundreds of orders/second on a single pair).
 * ════════════════════════════════════════════════════════════════════
 */

import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import { timedQuery } from "../observability/dbTiming";
import { lockPairForUpdate } from "./pairRepo";
import { isTradableSymbol } from "../market/marketSymbols";
import { getMarketReference, getCollarReference, collarBand, systemFillPrice, isOnMarket, type CollarReference } from "./priceCollar";
import { logger as rootLogger } from "../observability/logContext";

const logger = rootLogger.child({ module: "matchingEngine" });
import {
    createOrder,
    findOrderById,
    findOrderByIdForUpdate,
    updateOrderFill,
    setOrderStatus,
    fetchRestingOrdersBatch,
    } from "./orderRepo";
import type { OrderRow, BookCursor } from "./orderRepo";
import { createTrade } from "./tradeRepo";
import type { TradeRow } from "./tradeRepo";
import {
    findWalletByUserAndAsset,
    listScopeWalletIds,
    lockWalletsForUpdate,
    reserveFunds,
    releaseReserved,
    creditWalletTx,
    debitAvailableTx,
    debitUnconstrainedTx,
    consumeReservedAndDebitTx,
} from "../wallets/walletRepo";
import type { WalletRow, WalletScope } from "../wallets/walletRepo";
import Decimal from "decimal.js";
import { D, ZERO, BPS_DIVISOR, toFixed8 } from "../utils/decimal";
import { computeFee, maxFeeBps } from "./feeCalc";
import {
    buyingPower,
    isReduceOnly,
    isSystemUser,
    markPrice,
    marksForExposure,
    type BpWallet,
} from "./buyingPower";
import { isValidLeverage } from "./margin";
import { applyIsolatedFill, type IsolatedState } from "./isolatedPosition";
import { LEVERAGE_CEILING } from "./leverageConfig";
import {
    resolveTakerMargin,
    isolatedCap,
    readPosition,
    stateOf,
    lockIsolatedPositionTx,
    settleIsolatedFillTx,
    isolatedOpenCost,
    type IsolatedLeg,
    type PositionScope,
} from "./isolatedSettlement";
import {
    confirmLiquidation,
    closingSide,
    LiquidationNotNeeded,
    markOf,
    type LiquidationFill,
    type LiquidationRequest,
} from "./liquidation";

type FillPlan = {
    resting: OrderRow;
    fillQty: Decimal;
    fillPrice: Decimal;
    quoteAmt: Decimal;
    /** Taker fee (the incoming order). */
    feeAmt: Decimal;
    /** Maker fee (the resting order's owner). */
    makerFeeAmt: Decimal;
    counterBaseId: string;
    counterQuoteId: string;
};

export type PlaceOrderResult = {
    order: OrderRow;
    fills: TradeRow[];
    reference: CollarReference | null;
    /** Every wallet this order locked and may have changed (taker + makers), for wallet.updated after COMMIT. */
    walletIds: string[];
    /**
     * Legs settled ISOLATED, keyed `${tradeId}:TAKER` / `${tradeId}:MAKER`.
     * Their position rows are already updated here (the USD moves depend on
     * the position), so the post-fill pipeline must not apply them again.
     * Empty while LEVERAGE_ENABLED is off.
     */
    isolatedLegs?: Map<string, IsolatedLeg>;
    /**
     * Resting ISOLATED orders this order's sweep canceled because their fill
     * would have opened past what's allowed now (review #2): the reducing
     * part filled, the remainder was canceled. For events after COMMIT.
     */
    canceledMakers?: CanceledMaker[];
    /** Set when this order was a liquidation: what it booked. */
    liquidation?: LiquidationFill;
};

export type CanceledMaker = {
    order: OrderRow;
    reason: "leverage_exceeds_cap" | "insufficient_margin";
    releasedAmount: string;
};

/** A resting order that was placed ISOLATED (orders.margin_mode, migration 098). */
type IsolatedMaker = {
    leverage: Decimal;
    scope: PositionScope;
};

type SystemFillPlan = {
    fillQty: Decimal;
    fillPrice: Decimal;
    quoteAmt: Decimal;
    feeAmt: Decimal;
};

/**
 * Internal matching logic — operates on a caller-provided PoolClient.
 * Does NOT call BEGIN/COMMIT. The caller owns the transaction.
 */
async function placeOrderInternal(
    client: PoolClient,
    userId: string,
    pairId: string,
    side: "BUY" | "SELL",
    type: "MARKET" | "LIMIT",
    qty: string,
    limitPrice?: string,
    competitionId?: string | null,
    // matchId is stamped onto the order row (post-fill positions are scoped by
    // it) AND picks the wallets: a match order trades that match's own
    // wallets (migration 095), so it never touches free-play.
    matchId?: string | null,
    // Provenance tag, stamped onto the order row verbatim. Omitted/null =
    // manual user order (every existing caller). See phase6OrderService
    // for where 'agent' is checked against the AGENT_ACTIONS_ENABLED flag.
    source?: string | null,
    // MARKET pricing override — only for a solo replay session, whose orders
    // price off historical candles, not the live Kraken market. Omitted =
    // resolve the live Kraken reference (book, else ticker) under the pair lock.
    pricing?: CollarReference,
    // Requested leverage. Omitted/null = 1x, or the leverage already in force
    // on this pair/scope for an ISOLATED order. Anything above 1 needs the
    // ISOLATED path (LEVERAGE_ENABLED + a real user + a scope allowing it).
    leverage?: number | null,
    // A liquidation (liquidationEngine.ts): close the position the engine saw
    // breach, if it still does. side/qty are taken from the position under
    // the locks, not from the caller. A no-op throws LiquidationNotNeeded.
    liquidation?: LiquidationRequest,
): Promise<PlaceOrderResult> {
    // ── Phase A: Lock pair (Level 1) ──
    // Serializes all matching for this pair.  Every concurrent
    // placeOrder/cancelOrder on the same pair_id will queue here.
    const pair = await lockPairForUpdate(client, pairId);
    if (!pair || !pair.is_active) throw new Error("pair_not_found");
    // MARKET_SYMBOLS backstop — HTTP routes reject earlier (with details), but
    // agents, the trigger engine and the market maker reach this directly.
    if (!isTradableSymbol(pair.symbol)) throw new Error("pair_not_tradable");
    if (liquidation && (type !== "MARKET" || pricing)) throw new Error("invalid_liquidation_order");

    // Market reference (MARKET only): the real Kraken touch — fresh book, else
    // fresh ticker bid/ask. It bands which resting orders may be swept (at the
    // touch or better, never a stale quote far off market — see collarBand)
    // and prices the system-fill remainder. No
    // fresh reference → reject; never fall back to trading_pairs.last_price.
    // A liquidation is stricter: the fresh book only, never the ticker.
    let reference: CollarReference | null = null;
    let collar: { min: string; max: string } | null = null;
    if (type === "MARKET") {
        reference = liquidation
            ? getCollarReference(pairId)
            : pricing ?? await getMarketReference(pairId, pair.symbol);
        if (!reference) throw new Error("stale_price_source");
    }

    // ── Phase B: Find user's wallets (non-locking read) ──
    // The order's own account: a match order trades that match's wallets
    // (funded at accept, migration 095), never free-play.
    const scope: WalletScope = { competitionId: competitionId ?? null, matchId: matchId ?? null };
    const posScope: PositionScope = { competitionId: scope.competitionId ?? null, matchId: scope.matchId ?? null };
    const baseWallet = await findWalletByUserAndAsset(client, userId, pair.base_asset_id, scope);
    const quoteWallet = await findWalletByUserAndAsset(client, userId, pair.quote_asset_id, scope);
    if (!baseWallet || !quoteWallet) throw new Error(scope.matchId ? "match_wallets_missing" : "wallet_not_found");
    if (baseWallet.closed_at || quoteWallet.closed_at) throw new Error("match_ended");

    // ── Liquidation check #1 (under the pair lock) ──
    // Every order that changes this position holds the pair lock, and so
    // does match end (matchWallets.lockMatchPairsTx; a liquidation that
    // waited on it stops above with match_ended), so this read is current;
    // the size and side to close come from it. Check #2 repeats it under the
    // position row lock for any writer that doesn't take the pair lock.
    const liqMark = liquidation ? markOf(reference!) : null;
    // The position as check #2 found it under its row lock (for the liquidations row).
    let liquidatedFrom: IsolatedState | null = null;
    if (liquidation) {
        const row = await readPosition(client, userId, pairId, posScope, false);
        qty = toFixed8(confirmLiquidation(stateOf(row), row?.margin_mode ?? "SPOT", liquidation, liqMark!));
        side = closingSide(liquidation.side);
    }
    if (reference) {
        const band = collarBand(reference, side);
        collar = { min: band.min.toFixed(8), max: band.max.toFixed(8) };
    }

    // ── Phase B2: Margin model (isolatedSettlement.resolveTakerMargin) ──
    // SPOT is today's path. ISOLATED (LEVERAGE_ENABLED, real users) never
    // moves base: margin is locked out of USD into the position row.
    const leverageParam = leverage ?? null;
    if (leverageParam !== null && !isValidLeverage(leverageParam, LEVERAGE_CEILING)) {
        throw new Error("invalid_leverage");
    }
    const margin = await resolveTakerMargin(client, { userId, pairId, scope: posScope, replay: pricing?.source === "replay" });
    const isolated = margin.mode === "ISOLATED" ? margin : null;
    // Bots and @system.local users trade SPOT: never liquidated.
    if (liquidation && !isolated) throw new LiquidationNotNeeded("not_isolated");
    if (!isolated && leverageParam !== null && leverageParam > 1) throw new Error("leverage_exceeds_cap");
    // One leverage per (user, pair, scope) while a position or order is open.
    const orderLeverage = isolated ? (isolated.inherited ?? D(leverageParam ?? 1)) : D(1);

    // ── Phase C+D: Incrementally scan book and build execution plan ──
    // Reads resting orders under the pair lock (no competing matcher
    // can consume them).  Price filtering and self-trade prevention
    // are pushed into SQL.  Cursor-based keyset pagination caps
    // memory usage per batch.
    const plan: FillPlan[] = [];
    let remaining = D(qty);
    const bookSide: "BUY" | "SELL" = side === "BUY" ? "SELL" : "BUY";
    const priceBound = type === "LIMIT" ? limitPrice : undefined;
    const BATCH_SIZE = 100;
    let cursor: BookCursor | undefined;

    // Resting orders placed ISOLATED settle their maker leg ISOLATED, from
    // their own reserve, in their own scope — whatever the flag says now.
    const isolatedMakers = new Map<string, IsolatedMaker>();
    // Each ISOLATED maker's position as this sweep will leave it, so several
    // of its orders in one sweep see each other's fills.
    const makerBooks = new Map<string, { state: IsolatedState; cap: number; mmrBps: number }>();
    const cancelMakers = new Map<string, { resting: OrderRow; reason: CanceledMaker["reason"] }>();

    while (remaining.gt(0)) {
        const batch = await fetchRestingOrdersBatch(client, pairId, bookSide, {
            priceBound,
            priceMin: collar?.min,
            priceMax: collar?.max,
            excludeUserId: userId,
            cursor,
            batchSize: BATCH_SIZE,
        });

        if (batch.length === 0) break;

        const { rows: isoRows } = await timedQuery<{ id: string; leverage: string; competition_id: string | null; match_id: string | null }>(
            client, "matchingEngine.isolatedMakers",
            `SELECT id, leverage::text, competition_id, match_id FROM orders
             WHERE id = ANY($1::uuid[]) AND margin_mode = 'ISOLATED'`,
            [batch.map((o) => o.id)],
        );
        for (const r of isoRows) {
            isolatedMakers.set(r.id, { leverage: D(r.leverage), scope: { competitionId: r.competition_id, matchId: r.match_id } });
        }

        for (const resting of batch) {
            if (remaining.lte(0)) break;
            let fillQty = Decimal.min(remaining, D(resting.qty).minus(D(resting.qty_filled)));
            const fillPrice = D(resting.limit_price!);

            // ISOLATED maker: its reducing part always fills; a part that
            // would open (or flip past flat) fills only if its leverage is
            // still within the cap and its reserve covers margin + fee
            // (review #2). Otherwise the order fills what it can and the
            // rest of it is canceled with the reason.
            const iso = isolatedMakers.get(resting.id);
            if (iso) {
                const key = `${resting.user_id}:${iso.scope.competitionId ?? ""}:${iso.scope.matchId ?? ""}`;
                let book = makerBooks.get(key);
                if (!book) {
                    const row = await readPosition(client, resting.user_id, pairId, iso.scope, false);
                    const { cap, mmrBps } = await isolatedCap(client, resting.user_id, pairId, iso.scope);
                    book = { state: stateOf(row), cap, mmrBps };
                    makerBooks.set(key, book);
                }
                const makerSide = bookSide;
                const opposite = !book.state.qty.isZero() && book.state.qty.isPositive() !== (makerSide === "BUY");
                const reducible = opposite ? book.state.qty.abs() : ZERO;
                const opening = Decimal.max(ZERO, fillQty.minus(reducible));
                if (opening.gt(0)) {
                    let affordable = ZERO;
                    let reason: CanceledMaker["reason"] = "leverage_exceeds_cap";
                    if (iso.leverage.lte(book.cap)) {
                        reason = "insufficient_margin";
                        const reserveLeft = D(resting.reserved_amount).minus(D(resting.reserved_consumed));
                        const makerBps = D(computeFee("1", "MAKER", pair, resting.user_id).feeAmount);
                        const perUnit = fillPrice.div(iso.leverage).plus(fillPrice.mul(makerBps));
                        affordable = reserveLeft.div(perUnit).toDecimalPlaces(8, Decimal.ROUND_DOWN);
                    }
                    if (affordable.lt(opening)) {
                        fillQty = Decimal.min(fillQty, reducible.plus(affordable));
                        cancelMakers.set(resting.id, { resting, reason });
                    }
                }
                if (fillQty.lte(0)) continue;
                const makerFee = D(computeFee(toFixed8(fillQty.mul(fillPrice)), "MAKER", pair, resting.user_id).feeAmount);
                book.state = applyIsolatedFill(book.state, makerSide, fillQty, fillPrice, makerFee, iso.leverage, book.mmrBps).next;
            }

            // Fees derive from the rounded quote amount — the same input
            // the post-fill pipeline (positions, journal) feeds computeFee.
            const quoteStr = toFixed8(fillQty.mul(fillPrice));
            const quoteAmt = D(quoteStr);
            const feeAmt = D(computeFee(quoteStr, "TAKER", pair, userId).feeAmount);
            const makerFeeAmt = D(computeFee(quoteStr, "MAKER", pair, resting.user_id).feeAmount);
            plan.push({
                resting, fillQty, fillPrice, quoteAmt, feeAmt, makerFeeAmt,
                counterBaseId: "", counterQuoteId: "",
            });
            remaining = remaining.minus(fillQty);
        }

        // No more resting orders in the book
        if (batch.length < BATCH_SIZE) break;

        // Advance cursor past the last processed row
        const last = batch[batch.length - 1];
        cursor = { limitPrice: last.limit_price!, createdAt: last.created_at };
    }

    let systemFill: SystemFillPlan | null = null;
    if (type === "MARKET" && remaining.gt(0)) {
        // The real touch the taker crosses — no synthetic spread on top.
        // Known limitation: the whole remainder fills at the touch whatever
        // its size. There is no depth-based slippage (walking Kraken's book
        // levels), so a large order gets top-of-book price for all of it.
        const sysPrice = systemFillPrice(reference!, side);
        const sysQuoteStr = toFixed8(remaining.mul(sysPrice));
        const sysQuote = D(sysQuoteStr);
        const sysFee = D(computeFee(sysQuoteStr, "TAKER", pair, userId).feeAmount);
        systemFill = { fillQty: remaining, fillPrice: sysPrice, quoteAmt: sysQuote, feeAmt: sysFee };
        remaining = ZERO;
    }

    // ── Phase E: Check affordability ──
    // (ISOLATED: margin + fee, checked under the wallet locks in Phase F2.)
    if (type === "MARKET" && !isolated) {
        if (side === "BUY") {
            let totalCost = ZERO;
            for (const entry of plan) totalCost = totalCost.plus(entry.quoteAmt).plus(entry.feeAmt);
            if (systemFill) totalCost = totalCost.plus(systemFill.quoteAmt).plus(systemFill.feeAmt);
            const available = D(quoteWallet.balance).minus(D(quoteWallet.reserved));
            if (available.lt(totalCost)) throw new Error("insufficient_balance");
        }
        // A SELL needs no cash: closing a long frees it, and opening a short
        // is judged by buying power after the wallet lock (Phase F2).
    }

    let reserveAmount = ZERO;
    let reserveWalletId: string | null = null;
    if (type === "LIMIT" && !isolated) {
        if (side === "BUY") {
            // Reserve at the higher of maker/taker: the order may fill as either.
            reserveAmount = D(qty).mul(D(limitPrice!)).mul(BPS_DIVISOR.plus(D(maxFeeBps(pair)))).div(BPS_DIVISOR);
            const available = D(quoteWallet.balance).minus(D(quoteWallet.reserved));
            if (available.lt(reserveAmount)) throw new Error("insufficient_balance");
            reserveWalletId = quoteWallet.id;
        } else {
            // SELL LIMIT reserves base; reserved beyond holdings is a resting
            // short, which buying power counts (Phase F2).
            reserveAmount = D(qty);
            reserveWalletId = baseWallet.id;
        }
    }

    // ── Phase F: Lock wallets (Level 2) ──
    // Collect every wallet that will be debited/credited, then lock
    // them all in a single `FOR UPDATE` sorted by UUID.  The sort
    // order is critical: it guarantees that two concurrent
    // transactions touching overlapping wallet sets will acquire
    // locks in the same order, preventing deadlocks.
    const walletIdSet = new Set<string>([baseWallet.id, quoteWallet.id]);

    // Batch-fetch all counter-party wallets in a single query (2N → 1).
    // Each maker trades in ITS order's account, not the taker's: the scope
    // comes from the resting order's own reserved wallet (every resting LIMIT
    // has one). A match taker can hit a free-play maker (the MM bot) and each
    // side settles in its own wallets.
    if (plan.length > 0) {
        const reservedIds = [...new Set(plan.map((e) => e.resting.reserved_wallet_id).filter((id): id is string => !!id))];
        const counterWallets = await timedQuery<WalletRow & { reserved_id: string }>(
            client,
            "matchingEngine.batchCounterWallets",
            `SELECT r.id AS reserved_id, w.id, w.user_id, w.asset_id, w.balance, w.reserved,
                    w.created_at, w.updated_at, w.match_id, w.closed_at
             FROM wallets r
             JOIN wallets w
               ON w.user_id = r.user_id
              AND w.competition_id IS NOT DISTINCT FROM r.competition_id
              AND w.match_id IS NOT DISTINCT FROM r.match_id
             WHERE r.id = ANY($1::uuid[])
               AND w.asset_id IN ($2, $3)`,
            [reservedIds, pair.base_asset_id, pair.quote_asset_id],
        );

        const byReserved = new Map<string, WalletRow>();
        for (const w of counterWallets.rows) byReserved.set(`${w.reserved_id}:${w.asset_id}`, w);

        // A resting order with no reserved wallet (legacy/seeded) trades free-play.
        const legacyUserIds = [...new Set(plan.filter((e) => !e.resting.reserved_wallet_id).map((e) => e.resting.user_id))];
        const freePlay = new Map<string, WalletRow>();
        if (legacyUserIds.length > 0) {
            const { rows } = await timedQuery<WalletRow>(client, "matchingEngine.legacyCounterWallets",
                `SELECT id, user_id, asset_id, balance, reserved, created_at, updated_at, match_id, closed_at
                 FROM wallets
                 WHERE user_id = ANY($1::uuid[]) AND asset_id IN ($2, $3)
                   AND competition_id IS NULL AND match_id IS NULL`,
                [legacyUserIds, pair.base_asset_id, pair.quote_asset_id],
            );
            for (const w of rows) freePlay.set(`${w.user_id}:${w.asset_id}`, w);
        }

        for (const entry of plan) {
            const key = entry.resting.reserved_wallet_id;
            const counterBase = key
                ? byReserved.get(`${key}:${pair.base_asset_id}`)
                : freePlay.get(`${entry.resting.user_id}:${pair.base_asset_id}`);
            const counterQuote = key
                ? byReserved.get(`${key}:${pair.quote_asset_id}`)
                : freePlay.get(`${entry.resting.user_id}:${pair.quote_asset_id}`);
            if (!counterBase || !counterQuote) throw new Error("wallet_not_found");
            entry.counterBaseId = counterBase.id;
            entry.counterQuoteId = counterQuote.id;
            walletIdSet.add(counterBase.id);
            walletIdSet.add(counterQuote.id);
        }
    }

    // A resting order canceled by the fill-time check releases its reserve.
    for (const { resting } of cancelMakers.values()) {
        if (resting.reserved_wallet_id) walletIdSet.add(resting.reserved_wallet_id);
    }
    const walletIds = [...walletIdSet].sort();
    // Buying power reads every wallet in the user's scope, so lock them all
    // (same sorted single statement — no new deadlock order).
    const scopeWalletIds = await listScopeWalletIds(client, userId, scope);
    const locked = await lockWalletsForUpdate(client, [...new Set([...walletIds, ...scopeWalletIds])]);
    // Re-check under the lock: a match that ended while this order was in
    // flight closed its wallets (matchWallets.closeMatchWalletsTx) — the
    // Phase B read above was unlocked.
    if (locked.get(baseWallet.id)?.closed_at || locked.get(quoteWallet.id)?.closed_at) {
        throw new Error("match_ended");
    }

    if (isolated) {
        // ── Phase F2 (ISOLATED): leverage + margin ──
        // The position is locked last (pair → wallets → positions). The
        // immediate fills are walked against it with the settlement's own
        // math: closing parts need nothing, opening parts need margin + fee.
        // A LIMIT's resting remainder reserves margin + max fee in USD
        // whichever side it is (conservative: it may open when it fills).
        // USD free must cover both. Mark-to-market drops out: each position's
        // loss is confined to its margin.
        const { state: position, mode: positionMode } = await lockIsolatedPositionTx(client, userId, pairId, posScope);
        // ── Liquidation check #2 (under the position row lock) ──
        // Same episode, same side, same size as check #1, still breaching.
        // A match end that settled it first is caught here (flat) or by the
        // closed-wallet re-check above (match_ended).
        if (liquidation) {
            if (!confirmLiquidation(position, positionMode, liquidation, liqMark!).eq(D(qty))) {
                throw new LiquidationNotNeeded("size_changed");
            }
            liquidatedFrom = position;
        }
        const immediate = plan.map((e) => ({ qty: e.fillQty, price: e.fillPrice, fee: e.feeAmt }));
        if (systemFill) immediate.push({ qty: systemFill.fillQty, price: systemFill.fillPrice, fee: systemFill.feeAmt });
        const { cost, opensQty, after } = isolatedOpenCost(position, side, immediate, orderLeverage, isolated.mmrBps);

        // The resting remainder reserves only what would open: the part that
        // reduces the position — net of what the user's other resting orders
        // on this side already claim — needs nothing (its fee comes out of
        // the settlement, review #1). If the position shrinks some other way
        // before it fills, the fill-time check cancels the unfunded part.
        const restQty = type === "LIMIT" ? remaining : ZERO;
        const reducesAfter = !after.qty.isZero() && after.qty.isPositive() !== (side === "BUY");
        const reducible = reducesAfter ? Decimal.max(ZERO, after.qty.abs().minus(isolated.claimed[side])) : ZERO;
        const restOpenQty = Decimal.max(ZERO, restQty.minus(reducible));
        const restOpens = restOpenQty.gt(0);
        if (opensQty.gt(0) || restOpens) {
            if (leverageParam !== null && isolated.inherited !== null && !D(leverageParam).eq(isolated.inherited)) {
                throw new Error("leverage_mismatch");
            }
            if (orderLeverage.gt(isolated.cap)) throw new Error("leverage_exceeds_cap");
        }
        if (restQty.gt(0)) {
            const restNotional = restOpenQty.mul(D(limitPrice!));
            reserveAmount = restNotional.div(orderLeverage)
                .plus(restNotional.mul(D(maxFeeBps(pair))).div(BPS_DIVISOR))
                .toDecimalPlaces(8, Decimal.ROUND_UP);
            reserveWalletId = quoteWallet.id;
        }
        const lockedQuote = locked.get(quoteWallet.id) ?? quoteWallet;
        const free = D(lockedQuote.balance).minus(D(lockedQuote.reserved));
        if (free.lt(cost.plus(reserveAmount))) throw new Error("insufficient_balance");
    }

    // ── Phase F2: Buying power (2× rule, trading/buyingPower.ts) ──
    // Reduce-only orders always pass; system users (MM / risk bots) are exempt.
    // Anything that opens or adds risk must leave buying power >= 0 after it.
    const lockedBase = locked.get(baseWallet.id) ?? baseWallet;
    if (!isolated && !isReduceOnly(side, D(qty), lockedBase) && !(await isSystemUser(userId, client))) {
        const after: BpWallet[] = scopeWalletIds.map((id) => {
            const w = locked.get(id)!;
            return { assetId: w.asset_id, balance: w.balance, reserved: w.reserved };
        });
        const quoteAfter = after.find((w) => w.assetId === pair.quote_asset_id);
        const baseAfter = after.find((w) => w.assetId === pair.base_asset_id);
        if (!quoteAfter || !baseAfter) throw new Error("wallet_not_found");
        if (type === "MARKET") {
            let quoteSum = ZERO;
            let feeSum = ZERO;
            for (const e of plan) { quoteSum = quoteSum.plus(e.quoteAmt); feeSum = feeSum.plus(e.feeAmt); }
            if (systemFill) { quoteSum = quoteSum.plus(systemFill.quoteAmt); feeSum = feeSum.plus(systemFill.feeAmt); }
            const filled = D(qty).minus(remaining);
            if (side === "BUY") {
                quoteAfter.balance = D(quoteAfter.balance).minus(quoteSum).minus(feeSum).toString();
                baseAfter.balance = D(baseAfter.balance).plus(filled).toString();
            } else {
                quoteAfter.balance = D(quoteAfter.balance).plus(quoteSum).minus(feeSum).toString();
                baseAfter.balance = D(baseAfter.balance).minus(filled).toString();
            }
        } else if (side === "BUY") {
            quoteAfter.reserved = D(quoteAfter.reserved).plus(reserveAmount).toString();
        } else {
            baseAfter.reserved = D(baseAfter.reserved).plus(reserveAmount).toString();
        }
        const ownMark = reference
            ? reference.bestBid.plus(reference.bestAsk).div(2)
            : await markPrice(pairId, pair.symbol, pair.last_price);
        const marks = await marksForExposure(
            client, pair.quote_asset_id, after,
            new Map(ownMark ? [[pair.base_asset_id, ownMark]] : []),
        );
        const bp = buyingPower(pair.quote_asset_id, after, (assetId) => marks.get(assetId) ?? null);
        if (bp === null) throw new Error("stale_price_source");
        if (bp.lt(0)) throw new Error("insufficient_balance");
    }

    // ── Phase G: Reserve funds for LIMIT orders ──
    let reservedConsumed = ZERO;

    if (type === "LIMIT") {
        await reserveFunds(client, reserveWalletId!, toFixed8(reserveAmount));
    }

    // ── Phase H: Create the order row ──
    const order = await createOrder(client, {
        userId,
        pairId,
        side,
        type,
        limitPrice: limitPrice ?? null,
        qty,
        status: "OPEN",
        reservedWalletId: reserveWalletId,
        reservedAmount: toFixed8(reserveAmount),
        competitionId: competitionId ?? null,
        matchId: matchId ?? null,
        source: source ?? null,
        leverage: orderLeverage.toFixed(2),
        marginMode: margin.mode,
    });

    const mmrBps = isolated?.mmrBps ?? [...makerBooks.values()][0]?.mmrBps ?? 0;
    const isolatedLegs = new Map<string, IsolatedLeg>();

    // What a liquidation's taker legs booked, summed over its fills.
    const liqBooked = { quote: ZERO, pnl: ZERO, fee: ZERO, returned: ZERO, shortfall: ZERO };
    const noteLiquidationLeg = (
        fillQty: Decimal, fillPrice: Decimal,
        s: { bookedPnl: Decimal; shortfall: Decimal; released: Decimal; leg: IsolatedLeg },
    ) => {
        if (!liquidation) return;
        const fee = D(s.leg.feeBooked);
        liqBooked.quote = liqBooked.quote.plus(fillQty.mul(fillPrice));
        liqBooked.pnl = liqBooked.pnl.plus(s.bookedPnl);
        liqBooked.fee = liqBooked.fee.plus(fee);
        liqBooked.returned = liqBooked.returned.plus(s.released).plus(s.bookedPnl).minus(fee);
        liqBooked.shortfall = liqBooked.shortfall.plus(s.shortfall);
    };

    // ── Phase I: Execute book fills ──
    // All wallet locks are held — balance mutations are safe.
    const fills: TradeRow[] = [];
    let lastFillPrice: Decimal | null = null;

    for (const entry of plan) {
        const { resting, fillQty, fillPrice, quoteAmt, feeAmt, makerFeeAmt } = entry;

        // Pre-round financial amounts so derived values (debit = credit + fee)
        // are computed from rounded operands, guaranteeing exact ledger balance.
        const qtyStr = toFixed8(fillQty);
        const quoteStr = toFixed8(quoteAmt);
        const feeStr = toFixed8(feeAmt);
        const makerFeeStr = toFixed8(makerFeeAmt);

        const buyOrderId = side === "BUY" ? order.id : resting.id;
        const sellOrderId = side === "SELL" ? order.id : resting.id;

        const trade = await createTrade(client, {
            pairId,
            buyOrderId,
            sellOrderId,
            price: toFixed8(fillPrice),
            qty: qtyStr,
            quoteAmount: quoteStr,
            feeAmount: feeStr,
            feeAssetId: pair.quote_asset_id,
            isSystemFill: false,
        });

        const ts = new Date(trade.executed_at).getTime();
        const makerIso = isolatedMakers.get(resting.id);
        const makerSide: "BUY" | "SELL" = side === "BUY" ? "SELL" : "BUY";

        // Taker leg.
        if (isolated) {
            const settled = await settleIsolatedFillTx(client, {
                userId, pairId, scope: posScope, side, qty: qtyStr, price: toFixed8(fillPrice),
                fee: feeStr, feeRole: "TAKER", leverage: orderLeverage, mmrBps,
                usdWalletId: quoteWallet.id, tradeId: trade.id, ts,
            });
            isolatedLegs.set(`${trade.id}:TAKER`, settled.leg);
            noteLiquidationLeg(fillQty, fillPrice, settled);
        } else if (side === "BUY") {
            // Taker (buyer): debit quote (cost + fee), credit base
            const costPlusFee = toFixed8(D(quoteStr).plus(D(feeStr)));
            if (type === "MARKET") {
                await debitAvailableTx(client, quoteWallet.id, costPlusFee,
                    "TRADE_BUY", trade.id, "TRADE", { fee: feeStr, feeRole: "TAKER" });
            } else{
                await consumeReservedAndDebitTx(client, quoteWallet.id, costPlusFee,
                    "TRADE_BUY", trade.id, "TRADE", { fee: feeStr, feeRole: "TAKER" });
                reservedConsumed = reservedConsumed.plus(D(costPlusFee));
            }
            await creditWalletTx(client, baseWallet.id, qtyStr,
                "TRADE_BUY", trade.id, "TRADE");
        } else {
            //Taker (seller): debit base, credit quote minus fee
            const costMinusFee = toFixed8(D(quoteStr).minus(D(feeStr)));
            if (type === "MARKET") {
                await debitUnconstrainedTx(client, baseWallet.id, qtyStr,
                    "TRADE_SELL", trade.id, "TRADE");
            } else {
                await consumeReservedAndDebitTx(client, baseWallet.id, qtyStr,
                    "TRADE_SELL", trade.id, "TRADE");
                reservedConsumed = reservedConsumed.plus(D(qtyStr));
            }
            await creditWalletTx(client, quoteWallet.id, costMinusFee,
                "TRADE_SELL", trade.id, "TRADE", { fee: feeStr, feeRole: "TAKER" });
        }

        // Maker leg.
        const newMakerFilled = D(resting.qty_filled).plus(fillQty);
        const makerStatus = newMakerFilled.gte(D(resting.qty)) ? "FILLED" : "PARTIALLY_FILLED";
        if (makerIso) {
            // ISOLATED maker: margin + maker fee come out of its own reserve.
            const reserveLeft = D(resting.reserved_amount).minus(D(resting.reserved_consumed));
            const { leg, reserveUsed } = await settleIsolatedFillTx(client, {
                userId: resting.user_id, pairId, scope: makerIso.scope, side: makerSide,
                qty: qtyStr, price: toFixed8(fillPrice), fee: makerFeeStr, feeRole: "MAKER",
                leverage: makerIso.leverage, mmrBps, usdWalletId: entry.counterQuoteId,
                tradeId: trade.id, ts, reserve: reserveLeft,
            });
            isolatedLegs.set(`${trade.id}:MAKER`, leg);
            const usedStr = toFixed8(reserveUsed);
            await updateOrderFill(client, resting.id, qtyStr, usedStr, makerStatus);

            if (makerStatus === "FILLED" && resting.reserved_wallet_id) {
                const excess = reserveLeft.minus(D(usedStr));
                if (excess.gt(0)) await releaseReserved(client, resting.reserved_wallet_id, toFixed8(excess));
            }
        } else if (side === "BUY") {
            //Maker (seller): consume reserved base, credit quote minus maker fee
            await consumeReservedAndDebitTx(client, entry.counterBaseId, qtyStr,
                "TRADE_SELL", trade.id, "TRADE");
            await creditWalletTx(client, entry.counterQuoteId, toFixed8(D(quoteStr).minus(D(makerFeeStr))),
                "TRADE_SELL", trade.id, "TRADE", { fee: makerFeeStr, feeRole: "MAKER" });

            //update maker order (SELL maker: reserved in base, consumed = fillQty)
            await updateOrderFill(client, resting.id, qtyStr, qtyStr, makerStatus);

            if (makerStatus === "FILLED" && resting.reserved_wallet_id) {
                const newConsumed = D(resting.reserved_consumed).plus(D(qtyStr));
                const excess = D(resting.reserved_amount).minus(newConsumed);
                if (excess.gt(0)) await releaseReserved(client, resting.reserved_wallet_id, toFixed8(excess));
            }
        } else {
            //Maker (buyer): consume reserved quote (cost + maker fee), credit base.
            //The reserve was sized at maxFeeBps, so it always covers the fee.
            const makerCostPlusFee = toFixed8(D(quoteStr).plus(D(makerFeeStr)));
            await consumeReservedAndDebitTx(client, entry.counterQuoteId, makerCostPlusFee,
                "TRADE_BUY", trade.id, "TRADE", { fee: makerFeeStr, feeRole: "MAKER" });
            await creditWalletTx(client, entry.counterBaseId, qtyStr,
                "TRADE_BUY", trade.id, "TRADE");

            //Update maker order (BUY maker: reserved in quote, consumed = cost + maker fee)
            await updateOrderFill(client, resting.id, qtyStr, makerCostPlusFee, makerStatus);

            if (makerStatus === "FILLED" && resting.reserved_wallet_id) {
                const newConsumed = D(resting.reserved_consumed).plus(D(makerCostPlusFee));
                const excess = D(resting.reserved_amount).minus(newConsumed);
                if (excess.gt(0)) await releaseReserved(client, resting.reserved_wallet_id, toFixed8(excess));
            }
        }

        fills.push(trade);
        lastFillPrice = fillPrice
    }

    // ── Phase I2: Cancel resting ISOLATED orders the fill-time check stopped ──
    const canceledMakers: CanceledMaker[] = [];
    for (const { resting, reason } of cancelMakers.values()) {
        const row = (await findOrderByIdForUpdate(client, resting.id))!;
        const releasable = D(row.reserved_amount).minus(D(row.reserved_consumed));
        if (releasable.gt(0) && row.reserved_wallet_id) {
            await releaseReserved(client, row.reserved_wallet_id, toFixed8(releasable));
        }
        const { rows: [canceled] } = await timedQuery<OrderRow>(client, "matchingEngine.cancelMaker",
            `UPDATE orders SET status = 'CANCELED', cancel_reason = $2 WHERE id = $1
             RETURNING id, user_id, pair_id, side, type, limit_price, qty, qty_filled, status,
                       reserved_wallet_id, reserved_amount, reserved_consumed, created_at, updated_at, source`,
            [resting.id, reason],
        );
        logger.info({ orderId: resting.id, userId: resting.user_id, pairId, reason, released: toFixed8(releasable) },
            "resting_isolated_order_canceled");
        canceledMakers.push({ order: canceled, reason, releasedAmount: toFixed8(releasable) });
    }

    // ── Phase J: System fill (MARKET only) ──
    if (systemFill) {
        const { fillQty, fillPrice, quoteAmt, feeAmt } = systemFill;
        const sysQtyStr = toFixed8(fillQty);
        const sysQuoteStr = toFixed8(quoteAmt);
        const sysFeeStr = toFixed8(feeAmt);
        const buyOrderId = side === "BUY" ? order.id : null;
        const sellOrderId = side === "SELL" ? order.id : null;

        const trade = await createTrade(client, {
            pairId,
            buyOrderId,
            sellOrderId,
            price: toFixed8(fillPrice),
            qty: sysQtyStr,
            quoteAmount: sysQuoteStr,
            feeAmount: sysFeeStr,
            feeAssetId: pair.quote_asset_id,
            isSystemFill: true,
        });

        if (isolated) {
            const settled = await settleIsolatedFillTx(client, {
                userId, pairId, scope: posScope, side, qty: sysQtyStr, price: toFixed8(fillPrice),
                fee: sysFeeStr, feeRole: "TAKER", leverage: orderLeverage, mmrBps,
                usdWalletId: quoteWallet.id, tradeId: trade.id, ts: new Date(trade.executed_at).getTime(),
            });
            isolatedLegs.set(`${trade.id}:TAKER`, settled.leg);
            noteLiquidationLeg(fillQty, fillPrice, settled);
        } else if (side === "BUY") {
            const sysCostPlusFee = toFixed8(D(sysQuoteStr).plus(D(sysFeeStr)));
            await debitAvailableTx(client, quoteWallet.id, sysCostPlusFee,
                "TRADE_BUY", trade.id, "TRADE", { fee: sysFeeStr, feeRole: "TAKER" });
            await creditWalletTx(client, baseWallet.id, sysQtyStr,
                "TRADE_BUY", trade.id, "TRADE");
        } else {
            const sysCostMinusFee = toFixed8(D(sysQuoteStr).minus(D(sysFeeStr)));
            await debitUnconstrainedTx(client, baseWallet.id, sysQtyStr,
                "TRADE_SELL", trade.id, "TRADE");
            await creditWalletTx(client, quoteWallet.id, sysCostMinusFee,
                "TRADE_SELL", trade.id, "TRADE", { fee: sysFeeStr, feeRole: "TAKER" });
        }

        fills.push(trade);
        lastFillPrice = fillPrice;
    }

    // ── Phase K: Finalize order ──
    const totalFilled = D(qty).minus(remaining);
    let finalStatus: string;
    if (totalFilled.gte(D(qty))) {
        finalStatus = "FILLED";
    } else if (totalFilled.gt(0)) {
        finalStatus = "PARTIALLY_FILLED";
    } else if (type === "MARKET") {
        finalStatus = "REJECTED";
    } else {
        finalStatus = "OPEN";
    }

    const updatedOrder = await updateOrderFill(
        client, order.id, toFixed8(totalFilled), toFixed8(reservedConsumed), finalStatus
    );

    if (type === "LIMIT" && finalStatus === "FILLED") {
        const excess = reserveAmount.minus(reservedConsumed);
        if (excess.gt(0)) await releaseReserved(client, reserveWalletId!, toFixed8(excess));
    }

    // ── Phase L: Update pair.last_price (on-market fills only) ──
    // last_price is the live market reference other paths read, so a fill only
    // moves it when it printed within the collar of the real Kraken touch. An
    // off-market print — an uncollared LIMIT cross, a replay-session fill, any
    // fill with no fresh reference — leaves it to the Kraken ticker sync. (A
    // stale-quote sweep once wrote $63,566 into last_price with BTC at ~$84.6k.)
    if (lastFillPrice !== null) {
        const ref = reference ?? await getMarketReference(pairId, pair.symbol);
        if (isOnMarket(lastFillPrice, ref)) {
            await client.query(
                `UPDATE trading_pairs SET last_price = $1 WHERE id = $2`,
                [toFixed8(lastFillPrice), pairId]
            );
        } else {
            logger.warn(
                {
                    pairId,
                    fillPrice: toFixed8(lastFillPrice),
                    referenceSource: ref?.source ?? null,
                    bestBid: ref?.bestBid.toString() ?? null,
                    bestAsk: ref?.bestAsk.toString() ?? null,
                },
                "last_price_update_skipped_off_market",
            );
        }
    }

    let liquidationFill: LiquidationFill | undefined;
    if (liquidation && liquidatedFrom) {
        const closedQty = D(qty);
        liquidationFill = {
            userId,
            pairId,
            scope: posScope,
            epoch: liquidation.epoch,
            side: liquidation.side,
            qty: toFixed8(closedQty),
            entry: toFixed8(liquidatedFrom.entry),
            leverage: liquidatedFrom.leverage.toFixed(2),
            margin: toFixed8(liquidatedFrom.margin),
            liqPrice: toFixed8(liquidatedFrom.liqPrice!),
            mark: toFixed8(liqMark!),
            bookAgeMs: Math.round(reference!.ageMs),
            fillPrice: toFixed8(liqBooked.quote.div(closedQty)),
            realizedPnl: toFixed8(liqBooked.pnl),
            fee: toFixed8(liqBooked.fee),
            returnedEquity: toFixed8(liqBooked.returned),
            shortfall: toFixed8(liqBooked.shortfall),
        };
    }

    return { order: updatedOrder, fills, reference, walletIds, isolatedLegs, canceledMakers, liquidation: liquidationFill };
}

/**
 * Place an order with internally managed transaction (backward-compatible).
 * Acquires its own PoolClient, runs BEGIN/COMMIT/ROLLBACK.
 */
export async function placeOrder(
    userId: string,
    pairId: string,
    side: "BUY" | "SELL",
    type: "MARKET" | "LIMIT",
    qty: string,
    limitPrice?: string,
    competitionId?: string | null,
    matchId?: string | null,
    source?: string | null,
    pricing?: CollarReference,
    leverage?: number | null,
): Promise<PlaceOrderResult> {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");
        const result = await placeOrderInternal(client, userId, pairId, side, type, qty, limitPrice, competitionId, matchId, source, pricing, leverage);
        await client.query("COMMIT");
        return result;
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Place an order within a caller-managed transaction.
 * The caller owns BEGIN/COMMIT/ROLLBACK on the provided client.
 */
export async function placeOrderTx(
    client: PoolClient,
    userId: string,
    pairId: string,
    side: "BUY" | "SELL",
    type: "MARKET" | "LIMIT",
    qty: string,
    limitPrice?: string,
    competitionId?: string | null,
    matchId?: string | null,
    source?: string | null,
    pricing?: CollarReference,
    leverage?: number | null,
    liquidation?: LiquidationRequest,
): Promise<PlaceOrderResult> {
    return placeOrderInternal(client, userId, pairId, side, type, qty, limitPrice, competitionId, matchId, source, pricing, leverage, liquidation);
}

/**
 * Internal cancel logic — operates on a caller-provided PoolClient.
 * Does NOT call BEGIN/COMMIT. The caller owns the transaction.
 */
async function cancelOrderInternal(
    client: PoolClient,
    userId: string,
    orderId: string
): Promise<{ order: OrderRow; releasedAmount: string }> {
    // Non-locking read — fast-reject invalid/unauthorized requests
    // before acquiring the pair lock.
    const order = await findOrderById(orderId);
    if (!order) throw new Error("order_not_found");
    if (order.user_id !== userId) throw new Error("forbidden");
    if (["FILLED", "CANCELED", "REJECTED"].includes(order.status)) throw new Error("order_not_cancelable");

    // Level 1 — pair lock (same row placeOrder locks)
    await lockPairForUpdate(client, order.pair_id);

    // Re-read under FOR UPDATE — order may have been filled or
    // canceled by a concurrent placeOrder that held the pair lock
    // while we were waiting.
    const lockedOrder = await findOrderByIdForUpdate(client, orderId);
    if (!lockedOrder) throw new Error("order_not_found");
    if (["FILLED", "CANCELED", "REJECTED"].includes(lockedOrder.status)) {
        throw new Error("order_not_cancelable");
    }

    // Level 2 — wallet lock (single wallet, so sort is trivial)
    const releasable = D(lockedOrder.reserved_amount).minus(D(lockedOrder.reserved_consumed));
    if (releasable.gt(0) && lockedOrder.reserved_wallet_id) {
        await lockWalletsForUpdate(client, [lockedOrder.reserved_wallet_id]);
        await releaseReserved(client, lockedOrder.reserved_wallet_id, toFixed8(releasable));
    }

    const canceledOrder = await setOrderStatus(client, orderId, "CANCELED");

    return { order: canceledOrder, releasedAmount: toFixed8(releasable) };
}

/**
 * Cancel a resting order with internally managed transaction (backward-compatible).
 *
 * Locking order mirrors placeOrder:
 *   1. Pair lock (Level 1) — serializes with concurrent matches
 *   2. Wallet lock (Level 2) — protects reserved-funds release
 *
 * Double-check pattern: a non-locking read validates basic eligibility
 * before acquiring the pair lock, then the order is re-read under
 * `FOR UPDATE` to guard against races (e.g. the order was filled
 * between the two reads).
 */
export async function cancelOrder(
    userId: string,
    orderId: string
): Promise<{ order: OrderRow; releasedAmount: string }> {
    const client = await pool.connect();

    try{
        await client.query("BEGIN");
        const result = await cancelOrderInternal(client, userId, orderId);
        await client.query("COMMIT");
        return result;
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Cancel a resting order within a caller-managed transaction.
 * The caller owns BEGIN/COMMIT/ROLLBACK on the provided client.
 */
export async function cancelOrderTx(
    client: PoolClient,
    userId: string,
    orderId: string
): Promise<{ order: OrderRow; releasedAmount: string }> {
    return cancelOrderInternal(client, userId, orderId);
}
