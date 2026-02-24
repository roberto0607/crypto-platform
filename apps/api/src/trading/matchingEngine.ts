import { pool } from "../db/pool";
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

export async function placeOrder(
    userId: string,
    pairId: string,
    side: "BUY" | "SELL",
    type: "MARKET" | "LIMIT",
    qty: string,
    limitPrice?: string
): Promise<{ order: OrderRow; fills: TradeRow[] }> {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // Phase A: Lock pair, validate
        const pair = await lockPairForUpdate(client, pairId);
        if (!pair || !pair.is_active) throw new Error("pair_not_found");
        if (type === "MARKET" && !pair.last_price) throw new Error("no_price_available");

        //Phase B: Find user's wallets (non-locking read)
        const baseWallet = await findWalletByUserAndAsset(client, userId, pair.base_asset_id);
        const quoteWallet = await findWalletByUserAndAsset(client, userId, pair.quote_asset_id);
        if (!baseWallet || !quoteWallet) throw new Error("wallet_not_found");

        //Phase C+D: Incrementally scan book and build execution plan
        //  - Price filtering pushed into SQL (LIMIT taker orders only)
        //  - Row count capped per batch (avoids loading entire book)
        //  - Cursor-based keyset pagination for multi-batch iteration
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
                const feeAmt = quoteAmt.mul(pair.fee_bps).div(BPS_DIVISOR);
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

        //Phase E: Check affordability
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
                reserveAmount = D(qty).mul(D(limitPrice!)).mul(D(10000 + pair.fee_bps)).div(BPS_DIVISOR);
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

        //Phase F: Collect all wallet IDs, lock in sorted order
        const walletIdSet = new Set<string>([baseWallet.id, quoteWallet.id]);

        for (const entry of plan) {
            const counterBase = await findWalletByUserAndAsset(client, entry.resting.user_id, pair.base_asset_id);
            const counterQuote = await findWalletByUserAndAsset(client, entry.resting.user_id, pair.quote_asset_id);
            if (!counterBase || !counterQuote) throw new Error("wallet_not_found");
            entry.counterBaseId = counterBase.id;
            entry.counterQuoteId = counterQuote.id;
            walletIdSet.add(counterBase.id);
            walletIdSet.add(counterQuote.id);
        }

        await lockWalletsForUpdate(client, [...walletIdSet].sort());

        //Phase G: Reserve funds for LIMIT orders
        let reservedConsumed = ZERO;
        if (type === "LIMIT") {
            await reserveFunds(client, reserveWalletId!, toFixed8(reserveAmount));
        }

        //Phase H: Create the order row
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
        });

        //Phase I: Exectue book fills
        const fills: TradeRow[] = [];
        let lastFillPrice: Decimal | null = null;

        for (const entry of plan) {
            const { resting, fillQty, fillPrice, quoteAmt, feeAmt } = entry;

            const buyOrderId = side === "BUY" ? order.id : resting.id;
            const sellOrderId = side === "SELL" ? order.id : resting.id;

            const trade = await createTrade(client, {
                pairId,
                buyOrderId,
                sellOrderId,
                price: toFixed8(fillPrice),
                qty: toFixed8(fillQty),
                quoteAmount: toFixed8(quoteAmt),
                feeAmount: toFixed8(feeAmt),
                feeAssetId: pair.quote_asset_id,
                isSystemFill: false,
            });

            if( side === "BUY") {
                // Taker (buyer): debit quote (cost + fee), credit base
                if (type === "MARKET") {
                    await debitAvailableTx(client, quoteWallet.id, toFixed8(quoteAmt.plus(feeAmt)),
                        "TRADE_BUY", trade.id, "TRADE", { fee: toFixed8(feeAmt) });
                } else{
                    await consumeReservedAndDebitTx(client, quoteWallet.id, toFixed8(quoteAmt.plus(feeAmt)),
                        "TRADE_BUY", trade.id, "TRADE", { fee: toFixed8(feeAmt) });
                    reservedConsumed = reservedConsumed.plus(quoteAmt).plus(feeAmt);
                }
                await creditWalletTx(client, baseWallet.id, toFixed8(fillQty),
                    "TRADE_BUY", trade.id, "TRADE");

                //Maker (seller): consume reserved base, credit quote
                await consumeReservedAndDebitTx(client, entry.counterBaseId, toFixed8(fillQty),
                    "TRADE_SELL", trade.id, "TRADE");
                await creditWalletTx(client, entry.counterQuoteId, toFixed8(quoteAmt),
                    "TRADE_SELL", trade.id, "TRADE");

                //update maker order (SELL maker: reserved in base, consumed = fillQty)
                const newMakerFilled = D(resting.qty_filled).plus(fillQty);
                const makerStatus = newMakerFilled.gte(D(resting.qty)) ? "FILLED" : "PARTIALLY_FILLED";
                await updateOrderFill(client, resting.id, toFixed8(fillQty), toFixed8(fillQty), makerStatus);

                if (makerStatus === "FILLED" && resting.reserved_wallet_id) {
                    const newConsumed = D(resting.reserved_consumed).plus(fillQty);
                    const excess = D(resting.reserved_amount).minus(newConsumed);
                    if (excess.gt(0)) await releaseReserved(client, resting.reserved_wallet_id, toFixed8(excess));
                }
            } else{
                //Taker (seller): debit base, credit quote minus fee
                if (type === "MARKET") {
                    await debitAvailableTx(client, baseWallet.id, toFixed8(fillQty),
                        "TRADE_SELL", trade.id, "TRADE");
                } else {
                    await consumeReservedAndDebitTx(client, baseWallet.id, toFixed8(fillQty),
                        "TRADE_SELL", trade.id, "TRADE");
                    reservedConsumed = reservedConsumed.plus(fillQty);
                }
                await creditWalletTx(client, quoteWallet.id, toFixed8(quoteAmt.minus(feeAmt)),
                    "TRADE_SELL", trade.id, "TRADE", { fee: toFixed8(feeAmt) });

                //Maker (buyer): consume reserved quote, credit base
                await consumeReservedAndDebitTx(client, entry.counterQuoteId, toFixed8(quoteAmt),
                    "TRADE_BUY", trade.id, "TRADE");
                await creditWalletTx(client, entry.counterBaseId, toFixed8(fillQty),
                    "TRADE_BUY", trade.id, "TRADE");

                //Update maker order (BUY maker: reserved in quote, consumed = quoteAmt)
                const newMakerFilled = D(resting.qty_filled).plus(fillQty);
                const makerStatus = newMakerFilled.gte(D(resting.qty)) ? "FILLED" : "PARTIALLY_FILLED";
                await updateOrderFill(client, resting.id, toFixed8(fillQty), toFixed8(quoteAmt), makerStatus);

                if (makerStatus === "FILLED" && resting.reserved_wallet_id) {
                    const newConsumed = D(resting.reserved_consumed).plus(quoteAmt);
                    const excess = D(resting.reserved_amount).minus(newConsumed);
                    if (excess.gt(0)) await releaseReserved(client, resting.reserved_wallet_id, toFixed8(excess));
                }
            }

            fills.push(trade);
            lastFillPrice = fillPrice
        }

        //Phase J: System fill (MARKET only)
        if (systemFill) {
            const { fillQty, fillPrice, quoteAmt, feeAmt } = systemFill;
            const buyOrderId = side === "BUY" ? order.id : null;
            const sellOrderId = side === "SELL" ? order.id : null;

            const trade = await createTrade(client, {
                pairId,
                buyOrderId,
                sellOrderId,
                price: toFixed8(fillPrice),
                qty: toFixed8(fillQty),
                quoteAmount: toFixed8(quoteAmt),
                feeAmount: toFixed8(feeAmt),
                feeAssetId: pair.quote_asset_id,
                isSystemFill: true,
            });

            if (side === "BUY") {
                await debitAvailableTx(client, quoteWallet.id, toFixed8(quoteAmt.plus(feeAmt)),
                    "TRADE_BUY", trade.id, "TRADE", { fee: toFixed8(feeAmt) });
                await creditWalletTx(client, baseWallet.id, toFixed8(fillQty),
                    "TRADE_BUY", trade.id, "TRADE");
            } else {
                await debitAvailableTx(client, baseWallet.id, toFixed8(fillQty),
                    "TRADE_SELL", trade.id, "TRADE");
                await creditWalletTx(client, quoteWallet.id, toFixed8(quoteAmt.minus(feeAmt)),
                    "TRADE_SELL", trade.id, "TRADE", { fee: toFixed8(feeAmt) });
            }

            fills.push(trade);
            lastFillPrice = fillPrice;
        }

        //Phase K: Finalize order
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

        //Phase L: update pair.last_price
        if (lastFillPrice !== null) {
            await client.query(
                `UPDATE trading_pairs SET last_price = $1 WHERE id = $2`,
                [toFixed8(lastFillPrice), pairId]
            );
        }

        await client.query("COMMIT");
        return { order: updatedOrder, fills };
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

export async function cancelOrder(
    userId: string,
    orderId: string
): Promise<{ order: OrderRow; releasedAmount: string }> {
    const client = await pool.connect();

    try{
        await client.query("BEGIN");

        //Plain SELECT to get pair_id
        const order = await findOrderById(orderId);
        if (!order) throw new Error("order_not_found");
        if (order.user_id !== userId) throw new Error("forbidden");
        if (["FILLED", "CANCELED", "REJECTED"].includes(order.status)) throw new Error("order_not_cancelable");

        //Lock pair to serialize with matching
        await lockPairForUpdate(client, order.pair_id);

        //Re-read under lock
        const lockedOrder = await findOrderByIdForUpdate(client, orderId);
        if (!lockedOrder) throw new Error("order_not_found");
        if (["FILLED", "CANCELED", "REJECTED"].includes(lockedOrder.status)) {
            throw new Error("order_not_cancelable");
        }

        const releasable = D(lockedOrder.reserved_amount).minus(D(lockedOrder.reserved_consumed));
        if (releasable.gt(0) && lockedOrder.reserved_wallet_id) {
            await lockWalletsForUpdate(client, [lockedOrder.reserved_wallet_id]);
            await releaseReserved(client, lockedOrder.reserved_wallet_id, toFixed8(releasable));
        }

        const canceledOrder = await setOrderStatus(client, orderId, "CANCELED");

        await client.query("COMMIT");
        return { order: canceledOrder, releasedAmount: toFixed8(releasable) };
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

