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
    lockWalletsForUpdate,
    reserveFunds,
    releaseReserved,
    creditWalletTx,
    debitAvailableTx,
    consumeReservedAndDebitTx,
} from "../wallets/walletRepo";
import type { WalletRow } from "../wallets/walletRepo";
import { verifyPostTradeInvariants } from "./invariants";
import Decimal from "decimal.js";
import { D, ZERO, BPS_DIVISOR, toFixed8 } from "../utils/decimal";

type FillPlan = {
    resting: OrderRow;
    fillQty: Decimal;
    fillPrice: Decimal;
    quoteAmt: Decimal;
    feeAmt: Decimal;
    counterBaseId: string;
    counterQuoteId: string;
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
): Promise<{ order: OrderRow; fills: TradeRow[] }> {
    // ── Phase A: Lock pair (Level 1) ──
    // Serializes all matching for this pair.  Every concurrent
    // placeOrder/cancelOrder on the same pair_id will queue here.
    const pair = await lockPairForUpdate(client, pairId);
    if (!pair || !pair.is_active) throw new Error("pair_not_found");
    if (type === "MARKET" && !pair.last_price) throw new Error("no_price_available");

    // ── Phase B: Find user's wallets (non-locking read) ──
    const baseWallet = await findWalletByUserAndAsset(client, userId, pair.base_asset_id, competitionId);
    const quoteWallet = await findWalletByUserAndAsset(client, userId, pair.quote_asset_id, competitionId);
    if (!baseWallet || !quoteWallet) throw new Error("wallet_not_found");

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

    while (remaining.gt(0)) {
        const batch = await fetchRestingOrdersBatch(client, pairId, bookSide, {
            priceBound,
            excludeUserId: userId,
            cursor,
            batchSize: BATCH_SIZE,
        });

        if (batch.length === 0) break;

        for (const resting of batch) {
            if (remaining.lte(0)) break;
            const fillQty = Decimal.min(remaining, D(resting.qty).minus(D(resting.qty_filled)));
            const fillPrice = D(resting.limit_price!);
            const quoteAmt = fillQty.mul(fillPrice);
            const feeAmt = quoteAmt.mul(D(pair.fee_bps)).div(BPS_DIVISOR);
            plan.push({
                resting, fillQty, fillPrice, quoteAmt, feeAmt,
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
        const sysPrice = D(pair.last_price!);
        const sysQuote = remaining.mul(sysPrice);
        const sysFee = sysQuote.mul(pair.fee_bps).div(BPS_DIVISOR);
        systemFill = { fillQty: remaining, fillPrice: sysPrice, quoteAmt: sysQuote, feeAmt: sysFee };
        remaining = ZERO;
    }

    // ── Phase E: Check affordability ──
    if (type === "MARKET") {
        if (side === "BUY") {
            let totalCost = ZERO;
            for (const entry of plan) totalCost = totalCost.plus(entry.quoteAmt).plus(entry.feeAmt);
            if (systemFill) totalCost = totalCost.plus(systemFill.quoteAmt).plus(systemFill.feeAmt);
            const available = D(quoteWallet.balance).minus(D(quoteWallet.reserved));
            if (available.lt(totalCost)) throw new Error("insufficient_balance");
        } else {
            const available = D(baseWallet.balance).minus(D(baseWallet.reserved));
            if (available.lt(D(qty))) throw new Error("insufficient_balance");
        }
    }

    let reserveAmount = ZERO;
    let reserveWalletId: string | null = null;
    if (type === "LIMIT") {
        if (side === "BUY") {
            reserveAmount = D(qty).mul(D(limitPrice!)).mul(BPS_DIVISOR.plus(D(pair.fee_bps))).div(BPS_DIVISOR);
            const available = D(quoteWallet.balance).minus(D(quoteWallet.reserved));
            if (available.lt(reserveAmount)) throw new Error("insufficient_balance");
            reserveWalletId = quoteWallet.id;
        } else {
            reserveAmount = D(qty);
            const available = D(baseWallet.balance).minus(D(baseWallet.reserved));
            if (available.lt(reserveAmount)) throw new Error("insufficient_balance");
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

    // Batch-fetch all counter-party wallets in a single query (2N → 1)
    const counterUserIds = [...new Set(plan.map((e) => e.resting.user_id))];

    if (counterUserIds.length > 0) {
        const compFilter = (competitionId ?? null) === null
            ? `AND w.competition_id IS NULL`
            : `AND w.competition_id = $4`;
        const counterParams = (competitionId ?? null) === null
            ? [counterUserIds, pair.base_asset_id, pair.quote_asset_id]
            : [counterUserIds, pair.base_asset_id, pair.quote_asset_id, competitionId];

        const counterWallets = await timedQuery<WalletRow>(
            client,
            "matchingEngine.batchCounterWallets",
            `SELECT id, user_id, asset_id, balance, reserved, created_at, updated_at
             FROM wallets w
             WHERE w.user_id = ANY($1)
               AND w.asset_id IN ($2, $3)
               ${compFilter}`,
            counterParams
        );

        const walletMap = new Map<string, WalletRow>();
        for (const w of counterWallets.rows) {
            walletMap.set(`${w.user_id}:${w.asset_id}`, w);
        }

        for (const entry of plan) {
            const counterBase = walletMap.get(`${entry.resting.user_id}:${pair.base_asset_id}`);
            const counterQuote = walletMap.get(`${entry.resting.user_id}:${pair.quote_asset_id}`);
            if (!counterBase || !counterQuote) throw new Error("wallet_not_found");
            entry.counterBaseId = counterBase.id;
            entry.counterQuoteId = counterQuote.id;
            walletIdSet.add(counterBase.id);
            walletIdSet.add(counterQuote.id);
        }
    }

    await lockWalletsForUpdate(client, [...walletIdSet].sort());

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
    });

    // ── Phase I: Execute book fills ──
    // All wallet locks are held — balance mutations are safe.
    const fills: TradeRow[] = [];
    let lastFillPrice: Decimal | null = null;

    for (const entry of plan) {
        const { resting, fillQty, fillPrice, quoteAmt, feeAmt } = entry;

        // Pre-round financial amounts so derived values (debit = credit + fee)
        // are computed from rounded operands, guaranteeing exact ledger balance.
        const qtyStr = toFixed8(fillQty);
        const quoteStr = toFixed8(quoteAmt);
        const feeStr = toFixed8(feeAmt);

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

        if( side === "BUY") {
            // Taker (buyer): debit quote (cost + fee), credit base
            const costPlusFee = toFixed8(D(quoteStr).plus(D(feeStr)));
            if (type === "MARKET") {
                await debitAvailableTx(client, quoteWallet.id, costPlusFee,
                    "TRADE_BUY", trade.id, "TRADE", { fee: feeStr });
            } else{
                await consumeReservedAndDebitTx(client, quoteWallet.id, costPlusFee,
                    "TRADE_BUY", trade.id, "TRADE", { fee: feeStr });
                reservedConsumed = reservedConsumed.plus(D(costPlusFee));
            }
            await creditWalletTx(client, baseWallet.id, qtyStr,
                "TRADE_BUY", trade.id, "TRADE");

            //Maker (seller): consume reserved base, credit quote
            await consumeReservedAndDebitTx(client, entry.counterBaseId, qtyStr,
                "TRADE_SELL", trade.id, "TRADE");
            await creditWalletTx(client, entry.counterQuoteId, quoteStr,
                "TRADE_SELL", trade.id, "TRADE");

            //update maker order (SELL maker: reserved in base, consumed = fillQty)
            const newMakerFilled = D(resting.qty_filled).plus(fillQty);
            const makerStatus = newMakerFilled.gte(D(resting.qty)) ? "FILLED" : "PARTIALLY_FILLED";
            await updateOrderFill(client, resting.id, qtyStr, qtyStr, makerStatus);

            if (makerStatus === "FILLED" && resting.reserved_wallet_id) {
                const newConsumed = D(resting.reserved_consumed).plus(D(qtyStr));
                const excess = D(resting.reserved_amount).minus(newConsumed);
                if (excess.gt(0)) await releaseReserved(client, resting.reserved_wallet_id, toFixed8(excess));
            }
        } else{
            //Taker (seller): debit base, credit quote minus fee
            const costMinusFee = toFixed8(D(quoteStr).minus(D(feeStr)));
            if (type === "MARKET") {
                await debitAvailableTx(client, baseWallet.id, qtyStr,
                    "TRADE_SELL", trade.id, "TRADE");
            } else {
                await consumeReservedAndDebitTx(client, baseWallet.id, qtyStr,
                    "TRADE_SELL", trade.id, "TRADE");
                reservedConsumed = reservedConsumed.plus(D(qtyStr));
            }
            await creditWalletTx(client, quoteWallet.id, costMinusFee,
                "TRADE_SELL", trade.id, "TRADE", { fee: feeStr });

            //Maker (buyer): consume reserved quote, credit base
            await consumeReservedAndDebitTx(client, entry.counterQuoteId, quoteStr,
                "TRADE_BUY", trade.id, "TRADE");
            await creditWalletTx(client, entry.counterBaseId, qtyStr,
                "TRADE_BUY", trade.id, "TRADE");

            //Update maker order (BUY maker: reserved in quote, consumed = quoteAmt)
            const newMakerFilled = D(resting.qty_filled).plus(fillQty);
            const makerStatus = newMakerFilled.gte(D(resting.qty)) ? "FILLED" : "PARTIALLY_FILLED";
            await updateOrderFill(client, resting.id, qtyStr, quoteStr, makerStatus);

            if (makerStatus === "FILLED" && resting.reserved_wallet_id) {
                const newConsumed = D(resting.reserved_consumed).plus(D(quoteStr));
                const excess = D(resting.reserved_amount).minus(newConsumed);
                if (excess.gt(0)) await releaseReserved(client, resting.reserved_wallet_id, toFixed8(excess));
            }
        }

        fills.push(trade);
        lastFillPrice = fillPrice
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

        if (side === "BUY") {
            const sysCostPlusFee = toFixed8(D(sysQuoteStr).plus(D(sysFeeStr)));
            await debitAvailableTx(client, quoteWallet.id, sysCostPlusFee,
                "TRADE_BUY", trade.id, "TRADE", { fee: sysFeeStr });
            await creditWalletTx(client, baseWallet.id, sysQtyStr,
                "TRADE_BUY", trade.id, "TRADE");
        } else {
            const sysCostMinusFee = toFixed8(D(sysQuoteStr).minus(D(sysFeeStr)));
            await debitAvailableTx(client, baseWallet.id, sysQtyStr,
                "TRADE_SELL", trade.id, "TRADE");
            await creditWalletTx(client, quoteWallet.id, sysCostMinusFee,
                "TRADE_SELL", trade.id, "TRADE", { fee: sysFeeStr });
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

    // ── Phase L: Update pair.last_price ──
    if (lastFillPrice !== null) {
        await client.query(
            `UPDATE trading_pairs SET last_price = $1 WHERE id = $2`,
            [toFixed8(lastFillPrice), pairId]
        );
    }

    // ── Phase M: Post-trade financial integrity verification ──
    if (fills.length > 0) {
        const involvedOrderIds = [order.id, ...plan.map((e) => e.resting.id)];
        await verifyPostTradeInvariants(
            client,
            [...walletIdSet],
            involvedOrderIds,
            fills.map((f) => f.id),
        );
    }

    return { order: updatedOrder, fills };
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
): Promise<{ order: OrderRow; fills: TradeRow[] }> {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");
        const result = await placeOrderInternal(client, userId, pairId, side, type, qty, limitPrice, competitionId);
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
): Promise<{ order: OrderRow; fills: TradeRow[] }> {
    return placeOrderInternal(client, userId, pairId, side, type, qty, limitPrice, competitionId);
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
