import { pool } from "../db/pool";
import { getSnapshotForUser } from "../replay/replayEngine";
import { placeOrder } from "./matchingEngine";
import { computeFee } from "./feeCalc";
import { applyFillToPositionTx } from "../analytics/positionRepo";
import { getIdempotencyKey, putIdempotencyKeyTx } from "./idempotencyRepo";
import { findOrderById } from "./orderRepo";
import { listTradesByOrderId } from "./tradeRepo";
import { findPairById } from "./pairRepo";
import type { OrderRow } from "./orderRepo";
import type { TradeRow } from "./tradeRepo";
import type { Snapshot } from "../market/snapshotStore";
import { D, toFixed8 } from "../utils/decimal";
import { debitAvailableTx } from "../wallets/walletRepo";
import { findWalletByUserAndAsset } from "../wallets/walletRepo";
import { evaluateOrderRisk } from "../risk/riskEngine";
import { recordOrderAttempt, checkPriceDislocation } from "../risk/breakerService";
import { AppError } from "../errors/AppError";

export type PlaceOrderResult = {
    order: OrderRow;
    fills: TradeRow[];
    snapshot: Snapshot;
    fromIdempotencyCache: boolean;
};

/**
 * Resolve the current price snapshot for a user/pair.
 * Cascade: replay session → live Kraken → fallback (pair.last_price).
 */
export async function resolveSnapshot(
    userId: string,
    pairId: string
): Promise<Snapshot> {
    return getSnapshotForUser(userId, pairId);
}

/**
 * Phase 6 order placement wrapper.
 *
 * Responsibilities:
 *   1. Idempotency check (if key provided)
 *   2. Resolve snapshot (live/replay/fallback)
 *   3. Delegate to matchingEngine.placeOrder (unchanged)
 *   4. Post-fill: apply maker/taker fee ledger entries
 *   5. Post-fill: update positions + equity snapshots
 *   6. Insert idempotency key (if provided) atomically
 *
 * Does NOT modify matchingEngine.ts.
 * MARKET orders do NOT create persistent reservations.
 * LIMIT reservation behavior is preserved.
 */
export async function placeOrderWithSnapshot(
    userId: string,
    body: {
        pairId: string;
        side: "BUY" | "SELL";
        type: "MARKET" | "LIMIT";
        qty: string;
        limitPrice?: string;
    },
    idempotencyKey?: string
): Promise<PlaceOrderResult> {
    // ── 1. Idempotency check ──
    if (idempotencyKey) {
        const existing = await getIdempotencyKey(userId, idempotencyKey);
        if (existing) {
            const order = await findOrderById(existing.order_id);
            const fills = order ? await listTradesByOrderId(order.id) : [];
            const snapshot = existing.snapshot_json as Snapshot;
            return {
                order: order!,
                fills,
                snapshot,
                fromIdempotencyCache: true,
            };
        }
    }

    // ── 2. Resolve snapshot ──
    const snapshot = await resolveSnapshot(userId, body.pairId);

    // ── 2b. Pre-trade risk checks (Phase 6 PR3) ──
    const riskClient = await pool.connect();
    try {
        await riskClient.query("BEGIN");

        // Record order attempt (may trip rate abuse breaker)
        await recordOrderAttempt(riskClient, userId);

        // Check price dislocation (may trip price breaker)
        // Query on riskClient to avoid acquiring a second pool connection
        const { rows: pairRows } = await riskClient.query<{ last_price: string | null }>(
            `SELECT last_price FROM trading_pairs WHERE id = $1`,
            [body.pairId],
        );
        const dbLastPrice = pairRows[0]?.last_price;
        if (dbLastPrice) {
            await checkPriceDislocation(
                riskClient,
                body.pairId,
                snapshot.last,
                dbLastPrice
            );
        }

        // Evaluate all risk checks
        const decision = await evaluateOrderRisk(riskClient, {
            userId,
            pairId: body.pairId,
            side: body.side,
            type: body.type,
            qty: body.qty,
            limitPrice: body.limitPrice,
            snapshot,
        });

        await riskClient.query("COMMIT");

        if (!decision.ok) {
            throw new AppError("risk_check_failed", {
                code: decision.code,
                reason: decision.reason,
                ...decision.details,
            });
        }
    } catch (err) {
        await riskClient.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        riskClient.release();
    }

    // ── 3. Delegate to matching engine ──
    const result = await placeOrder(
        userId,
        body.pairId,
        body.side,
        body.type,
        body.qty,
        body.limitPrice
    );

    // ── 4+5. Post-fill processing (fees + positions) ──
    if (result.fills.length > 0) {
        const pair = await findPairById(body.pairId);
        if (pair) {
            const client = await pool.connect();
            let idempotencyRowCount = 1;
            try {
                await client.query("BEGIN");

                for (const fill of result.fills) {
                    const fillPrice = fill.price;
                    const fillQty = fill.qty;
                    const quoteAmount = fill.quote_amount;
                    const executedAtMs = new Date(fill.executed_at).getTime();

                    // Determine taker fee for position tracking
                    // The matching engine already charged fee_bps (unified).
                    // We compute the maker/taker split for position fee tracking.
                    const takerFee = computeFee(
                        quoteAmount,
                        "TAKER",
                        pair.maker_fee_bps,
                        pair.taker_fee_bps,
                        pair.quote_asset_id
                    );

                    // Apply fill to taker's position
                    await applyFillToPositionTx(client, {
                        userId,
                        pairId: body.pairId,
                        side: body.side,
                        qty: fillQty,
                        price: fillPrice,
                        feeQuote: takerFee.feeAmount,
                        ts: executedAtMs,
                    });

                    // Apply fill to maker's position (if not system fill)
                    if (!fill.is_system_fill) {
                        const makerOrderId = body.side === "BUY" ? fill.sell_order_id : fill.buy_order_id;
                        let makerUserId: string | null = null;
                        if (makerOrderId) {
                            const makerResult = await client.query<{ user_id: string }>(
                                `SELECT user_id FROM orders WHERE id = $1`,
                                [makerOrderId]
                            );
                            makerUserId = makerResult.rows[0]?.user_id ?? null;
                        }

                        if (makerUserId) {
                            const makerSide = body.side === "BUY" ? "SELL" : "BUY";
                            const makerFee = computeFee(
                                quoteAmount,
                                "MAKER",
                                pair.maker_fee_bps,
                                pair.taker_fee_bps,
                                pair.quote_asset_id
                            );

                            await applyFillToPositionTx(client, {
                                userId: makerUserId,
                                pairId: body.pairId,
                                side: makerSide as "BUY" | "SELL",
                                qty: fillQty,
                                price: fillPrice,
                                feeQuote: makerFee.feeAmount,
                                ts: executedAtMs,
                            });
                        }
                    }
                }

                // ── 6. Insert idempotency key ──
                if (idempotencyKey) {
                    idempotencyRowCount = await putIdempotencyKeyTx(client, userId, idempotencyKey, result.order.id, snapshot);

                }

                await client.query("COMMIT");
            } catch (err) {
                await client.query("ROLLBACK");
                throw err;
            } finally {
                client.release();
            }
                        // ── 6b. Race recovery: another request won the idempotency insert ──
            if (idempotencyKey && idempotencyRowCount === 0) {
                const winner = await getIdempotencyKey(userId, idempotencyKey);
                if (winner) {
                    const winnerOrder = await findOrderById(winner.order_id);
                    const winnerFills = winnerOrder ? await listTradesByOrderId(winnerOrder.id) : [];
                    return {
                        order: winnerOrder!,
                        fills: winnerFills,
                        snapshot: winner.snapshot_json as Snapshot,
                        fromIdempotencyCache: true,
                    };
                }
            }

        }
    } else if (idempotencyKey) {
        // No fills but still need to store idempotency key
        const client = await pool.connect();
        let noFillRowCount = 1;
        try {
            await client.query("BEGIN");
            noFillRowCount = await putIdempotencyKeyTx(client, userId, idempotencyKey, result.order.id, snapshot);
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }

        // ── Race recovery for no-fills path ──
        if (noFillRowCount === 0) {
            const winner = await getIdempotencyKey(userId, idempotencyKey);
            if (winner) {
                const winnerOrder = await findOrderById(winner.order_id);
                const winnerFills = winnerOrder ? await listTradesByOrderId(winnerOrder.id) : [];
                return {
                    order: winnerOrder!,
                    fills: winnerFills,
                    snapshot: winner.snapshot_json as Snapshot,
                    fromIdempotencyCache: true,
                };
            }
        }
    }

    return {
        order: result.order,
        fills: result.fills,
        snapshot,
        fromIdempotencyCache: false,
    };
}
