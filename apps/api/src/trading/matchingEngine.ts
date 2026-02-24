import { pool } from "../db/pool";
import { lockPairForUpdate } from "./pairRepo";
import {
    createOrder,
    findOrderById,
    findOrderByIdForUpdate,
    updateOrderFill,
    setOrderStatus,
    getRestingSellOrders,
    getRestingBuyOrders,
    } from "./orderRepo";
import type { OrderRow } from "./orderRepo";
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

type FillPlan = {
    resting: OrderRow;
    fillQty: number;
    fillPrice: number;
    quoteAmt: number;
    feeAmt: number;
    counterBaseId: string;
    counterQuoteId: string;
};

type SystemFillPlan = {
    fillQty: number;
    fillPrice: number;
    quoteAmt: number;
    feeAmt: number;
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

        //Phase C: Scan book for matchable resting orders
        const restingOrders = side === "BUY"
            ? await getRestingSellOrders(client, pairId)
            : await getRestingBuyOrders(client, pairId);

        const matchableOrders: OrderRow[] = [];
        for (const resting of restingOrders) {
            if (type === "LIMIT") {
                if (side === "BUY" && parseFloat(resting.limit_price!) > parseFloat(limitPrice!)) break;
                if (side === "SELL" && parseFloat(resting.limit_price!) < parseFloat(limitPrice!)) break;
            }
            matchableOrders.push(resting);
        }

        //Phase D: Build execution plan
        const plan: FillPlan[] = [];
        let remaining = parseFloat(qty);

        for (const resting of matchableOrders) {
            if (remaining <= 0) break;
            const fillQty = Math.min(remaining, parseFloat(resting.qty) - parseFloat(resting.qty_filled));
            const fillPrice = parseFloat(resting.limit_price!);
            const quoteAmt = parseFloat((fillQty * fillPrice).toFixed(8));
            const feeAmt = parseFloat((quoteAmt * pair.fee_bps / 10000).toFixed(8));
            plan.push({
                resting, fillQty, fillPrice, quoteAmt, feeAmt,
                counterBaseId: "", counterQuoteId: "",
            });
            remaining = parseFloat((remaining - fillQty).toFixed(8));
        }

        let systemFill: SystemFillPlan | null = null;
        if (type === "MARKET" && remaining > 0) {
            const sysPrice = parseFloat(pair.last_price!);
            const sysQuote = parseFloat((remaining * sysPrice).toFixed(8));
            const sysFee = parseFloat((sysQuote * pair.fee_bps / 10000).toFixed(8));
            systemFill = { fillQty: remaining, fillPrice: sysPrice, quoteAmt: sysQuote, feeAmt: sysFee };
            remaining = 0;
        }

        //Phase E: Check affordability
        if (type === "MARKET") {
            if (side === "BUY") {
                let totalCost = 0;
                for (const entry of plan) totalCost += entry.quoteAmt + entry.feeAmt;
                if (systemFill) totalCost += systemFill.quoteAmt + systemFill.feeAmt;
                const available = parseFloat(quoteWallet.balance) - parseFloat(quoteWallet.reserved);
                if (available < totalCost) throw new Error("insufficient_balance");
            } else {
                const available = parseFloat(baseWallet.balance) - parseFloat(baseWallet.reserved);
                if (available < parseFloat(qty)) throw new Error("insufficient_balance");
            }
        }

        let reserveAmount = 0;
        let reserveWalletId: string | null = null;
        if (type === "LIMIT") {
            if (side === "BUY") {
                reserveAmount = parseFloat(
                    (parseFloat(qty) * parseFloat(limitPrice!) * (10000 + pair.fee_bps) / 10000).toFixed(8)
                );
                const available = parseFloat(quoteWallet.balance) - parseFloat(quoteWallet.reserved);
                if (available < reserveAmount) throw new Error("insufficient_balance");
                reserveWalletId = quoteWallet.id;
            } else {
                reserveAmount = parseFloat(qty);
                const available = parseFloat(baseWallet.balance) - parseFloat(baseWallet.reserved);
                if (available < reserveAmount) throw new Error("insufficient_balance");
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
        let reservedConsumed = 0;
        if (type === "LIMIT") {
            await reserveFunds(client, reserveWalletId!, reserveAmount.toFixed(8));
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
            reservedAmount: reserveAmount.toFixed(8),
        });

        //Phase I: Exectue book fills
        const fills: TradeRow[] = [];
        let lastFillPrice: number | null = null;

        for (const entry of plan) {
            const { resting, fillQty, fillPrice, quoteAmt, feeAmt } = entry;

            const buyOrderId = side === "BUY" ? order.id : resting.id;
            const sellOrderId = side === "SELL" ? order.id : resting.id;

            const trade = await createTrade(client, {
                pairId,
                buyOrderId,
                sellOrderId,
                price: fillPrice.toFixed(8),
                qty: fillQty.toFixed(8),
                quoteAmount: quoteAmt.toFixed(8),
                feeAmount: feeAmt.toFixed(8),
                feeAssetId: pair.quote_asset_id,
                isSystemFill: false,
            });

            if( side === "BUY") {
                // Taker (buyer): debit quote (cost + fee), credit base
                if (type === "MARKET") {
                    await debitAvailableTx(client, quoteWallet.id, (quoteAmt + feeAmt).toFixed(8),
                        "TRADE_BUY", trade.id, "TRADE", { fee: feeAmt.toFixed(8) });
                } else{
                    await consumeReservedAndDebitTx(client, quoteWallet.id, (quoteAmt + feeAmt).toFixed(8),
                        "TRADE_BUY", trade.id, "TRADE", { fee: feeAmt.toFixed(8) });
                    reservedConsumed += quoteAmt + feeAmt;
                }
                await creditWalletTx(client, baseWallet.id, fillQty.toFixed(8),
                    "TRADE_BUY", trade.id, "TRADE");

                //Maker (seller): consume reserved base, credit quote
                await consumeReservedAndDebitTx(client, entry.counterBaseId, fillQty.toFixed(8),
                    "TRADE_SELL", trade.id, "TRADE");
                await creditWalletTx(client, entry.counterQuoteId, quoteAmt.toFixed(8),
                    "TRADE_SELL", trade.id, "TRADE");

                //update maker order (SELL maker: reserved in base, consumed = fillQty)
                const newMakerFilled = parseFloat(resting.qty_filled) + fillQty;
                const makerStatus = newMakerFilled >= parseFloat(resting.qty) ? "FILLED" : "PARTIALLY_FILLED";
                await updateOrderFill(client, resting.id, fillQty.toFixed(8), fillQty.toFixed(8), makerStatus);

                if (makerStatus === "FILLED" && resting.reserved_wallet_id) {
                    const newConsumed = parseFloat(resting.reserved_consumed) + fillQty;
                    const excess = parseFloat(resting.reserved_amount) - newConsumed;
                    if (excess > 0) await releaseReserved(client, resting.reserved_wallet_id, excess.toFixed(8));
                }
            } else{
                //Taker (seller): debit base, credit quote minus fee
                if (type === "MARKET") {
                    await debitAvailableTx(client, baseWallet.id, fillQty.toFixed(8),
                        "TRADE_SELL", trade.id, "TRADE");
                } else {
                    await consumeReservedAndDebitTx(client, baseWallet.id, fillQty.toFixed(8),
                        "TRADE_SELL", trade.id, "TRADE");
                    reservedConsumed += fillQty;
                }
                await creditWalletTx(client, quoteWallet.id, (quoteAmt - feeAmt).toFixed(8),
                    "TRADE_SELL", trade.id, "TRADE", { fee: feeAmt.toFixed(8) });

                //Maker (buyer): consume reserved quote, credit base
                await consumeReservedAndDebitTx(client, entry.counterQuoteId, quoteAmt.toFixed(8),
                    "TRADE_BUY", trade.id, "TRADE");
                await creditWalletTx(client, entry.counterBaseId, fillQty.toFixed(8),
                    "TRADE_BUY", trade.id, "TRADE");

                //Update maker order (BUY maker: reserved in quote, consumed = quoteAmt)
                const newMakerFilled = parseFloat(resting.qty_filled) + fillQty;
                const makerStatus = newMakerFilled >= parseFloat(resting.qty) ? "FILLED" : "PARTIALLY_FILLED";
                await updateOrderFill(client, resting.id, fillQty.toFixed(8), quoteAmt.toFixed(8), makerStatus);

                if (makerStatus === "FILLED" && resting.reserved_wallet_id) {
                    const newConsumed = parseFloat(resting.reserved_consumed) + quoteAmt;
                    const excess = parseFloat(resting.reserved_amount) - newConsumed;
                    if (excess > 0) await releaseReserved(client, resting.reserved_wallet_id, excess.toFixed(8));
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
                price: fillPrice.toFixed(8),
                qty: fillQty.toFixed(8),
                quoteAmount: quoteAmt.toFixed(8),
                feeAmount: feeAmt.toFixed(8),
                feeAssetId: pair.quote_asset_id,
                isSystemFill: true,
            });

            if (side === "BUY") {
                await debitAvailableTx(client, quoteWallet.id, (quoteAmt + feeAmt).toFixed(8),
                    "TRADE_BUY", trade.id, "TRADE", { fee: feeAmt.toFixed(8) });
                await creditWalletTx(client, baseWallet.id, fillQty.toFixed(8),
                    "TRADE_BUY", trade.id, "TRADE");
            } else {
                await debitAvailableTx(client, baseWallet.id, fillQty.toFixed(8),
                    "TRADE_SELL", trade.id, "TRADE");
                await creditWalletTx(client, quoteWallet.id, (quoteAmt - feeAmt).toFixed(8),
                    "TRADE_SELL", trade.id, "TRADE", { fee: feeAmt.toFixed(8) });
            }

            fills.push(trade);
            lastFillPrice = fillPrice;
        }

        //Phase K: Finalize order
        const totalFilled = parseFloat(qty) - remaining;
        let finalStatus: string;
        if (totalFilled >= parseFloat(qty)) {
            finalStatus = "FILLED";
        } else if (totalFilled > 0) {
            finalStatus = "PARTIALLY_FILLED";
        } else if (type === "MARKET") {
            finalStatus = "REJECTED";
        } else {
            finalStatus = "OPEN";
        }

        const updatedOrder = await updateOrderFill(
            client, order.id, totalFilled.toFixed(8), reservedConsumed.toFixed(8), finalStatus
        );

        if (type === "LIMIT" && finalStatus === "FILLED") {
            const excess = reserveAmount - reservedConsumed;
            if (excess > 0) await releaseReserved(client, reserveWalletId!, excess.toFixed(8));
        }

        //Phase L: update pair.last_price
        if (lastFillPrice !== null) {
            await client.query(
                `UPDATE trading_pairs SET last_price = $1 WHERE id = $2`,
                [lastFillPrice?.toFixed(8), pairId]
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

        const releasable = parseFloat(lockedOrder.reserved_amount) - parseFloat(lockedOrder.reserved_consumed);
        if (releasable > 0 && lockedOrder.reserved_wallet_id) {
            await lockWalletsForUpdate(client, [lockedOrder.reserved_wallet_id]);
            await releaseReserved(client, lockedOrder.reserved_wallet_id, releasable.toFixed(8));
        }

        const canceledOrder = await setOrderStatus(client, orderId, "CANCELED");

        await client.query("COMMIT");
        return { order: canceledOrder, releasedAmount: releasable.toFixed(8) };
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

