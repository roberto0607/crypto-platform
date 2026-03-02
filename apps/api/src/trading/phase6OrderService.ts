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
import { evaluateAccountGovernance } from "../governance/governanceEngine";
import { recordOrderAttempt, checkPriceDislocation } from "../risk/breakerService";
import { AppError } from "../errors/AppError";
import { publish } from "../events/eventBus";
import { createEvent } from "../events/eventTypes";
import { eventsPublishedTotal } from "../metrics";
import { buildLogContext, logger } from "../observability/logContext";
import {
  orderPlacementLatency,
  ordersCreatedTotal,
  ordersRejectedTotal,
} from "../metrics";
import { writePortfolioSnapshot } from "../portfolio/portfolioService";
import { resolveSimulationConfig } from "../sim/simConfigRepo";
import { computeMarketExecution } from "../sim/slippageModel";
import { computeAvailableLiquidity } from "../sim/liquidityModel";
import { recordEvent } from "../eventStream/eventService";

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
    idempotencyKey?: string,
    requestId?: string
): Promise<PlaceOrderResult> {
    const startMs = performance.now();
    const logCtx = buildLogContext({
      requestId: requestId ?? "no-request",
      userId,
      pairId: body.pairId,
      idempotencyKey,
    });
    logger.info({ ...logCtx, eventType: "order.placement_started" }, "Order placement started");

    // ── 1. Idempotency check ──
    if (idempotencyKey) {
        const existing = await getIdempotencyKey(userId, idempotencyKey);
        if (existing) {
            const order = await findOrderById(existing.order_id);
            const fills = order ? await listTradesByOrderId(order.id) : [];
            const snapshot = existing.snapshot_json as Snapshot;
            logger.info({ ...logCtx, eventType: "order.idempotency_hit" }, "Idempotency cache hit");
            orderPlacementLatency.observe(performance.now() - startMs);
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

    // ── 2a. Estimate notional for governance ──
    const estimatedNotional = D(body.qty).mul(D(snapshot.last)).toFixed(8);

    // ── 2b. Pre-trade risk checks (Phase 6 PR3) ──
    const riskClient = await pool.connect();
    try {
        await riskClient.query("BEGIN");

        // ── 2b-gov. Account governance check (Phase 9 PR1) ──
        const govDecision = await evaluateAccountGovernance(riskClient, {
            userId,
            pairId: body.pairId,
            side: body.side,
            qty: body.qty,
            estimatedNotional,
            snapshotTs: snapshot.ts,
        });

        if (!govDecision.ok) {
            ordersRejectedTotal.inc({ reason: govDecision.code ?? "governance" });
            logger.warn({ ...logCtx, eventType: "order.rejected", reason: govDecision.code }, "Order rejected by governance");
            orderPlacementLatency.observe(performance.now() - startMs);
            throw new AppError("governance_check_failed", {
                code: govDecision.code,
                message: govDecision.message,
                ...govDecision.details,
            });
        }

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
            ordersRejectedTotal.inc({ reason: decision.code ?? "unknown" });
            logger.warn({ ...logCtx, eventType: "order.rejected", reason: decision.code }, "Order rejected by risk controls");
            orderPlacementLatency.observe(performance.now() - startMs);
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

    // ── 2c. Simulation: slippage + liquidity (MARKET only) ──
    if (body.type === "MARKET") {
        const simConfig = await resolveSimulationConfig(userId, body.pairId);

        const { rows: candleRows } = await pool.query<{
            volume: string; high: string; low: string;
        }>(
            `SELECT volume, high, low FROM candles
             WHERE pair_id = $1 AND ts <= $2
             ORDER BY ts DESC LIMIT 1`,
            [body.pairId, snapshot.ts]
        );
        const candle = candleRows[0] ?? null;

        const simResult = computeMarketExecution(
            snapshot,
            body.side,
            body.qty,
            simConfig,
            candle?.volume ?? null,
            candle?.high ?? null,
            candle?.low ?? null
        );

        if (!simResult) {
            const reqNotional = D(body.qty).mul(D(snapshot.last));
            const availLiq = computeAvailableLiquidity(
                simConfig, candle?.volume ?? null, snapshot.last
            );
            ordersRejectedTotal.inc({ reason: "insufficient_liquidity" });
            logger.warn({ ...logCtx, eventType: "order.rejected", reason: "insufficient_liquidity" },
                "Order rejected: insufficient liquidity");
            orderPlacementLatency.observe(performance.now() - startMs);
            throw new AppError("insufficient_liquidity", {
                requestedNotional: toFixed8(reqNotional),
                availableLiquidity: availLiq,
            });
        }

        // Override last_price so matching engine system fill uses slippage-adjusted price
        await pool.query(
            `UPDATE trading_pairs SET last_price = $1 WHERE id = $2`,
            [simResult.execPrice, body.pairId]
        );
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
            // ── Emit events (after commit, fire-and-forget) ──
            try {
                publish(createEvent("order.updated", {
                    orderId: result.order.id,
                    pairId: body.pairId,
                    side: body.side,
                    type: body.type,
                    status: result.order.status,
                    qty: body.qty,
                    filledQty: result.order.qty_filled,
                    limitPrice: body.limitPrice ?? null,
                }, { userId, requestId }));
                eventsPublishedTotal.inc({ type: "order.updated" });

                for (const fill of result.fills) {
                    publish(createEvent("trade.created", {
                        tradeId: fill.id,
                        orderId: result.order.id,
                        pairId: body.pairId,
                        side: body.side,
                        price: fill.price,
                        qty: fill.qty,
                        quoteAmount: fill.quote_amount,
                    }, { userId, requestId }));
                    eventsPublishedTotal.inc({ type: "trade.created" });
                }
            } catch {
                // Events must never break the order flow
            }

            // ── Event stream: order placed + trades (fire-and-forget) ──
            recordEvent({
                eventType: "ORDER_PLACED",
                entityType: "ORDER",
                entityId: result.order.id,
                actorUserId: userId,
                payload: { side: body.side, type: body.type, qty: body.qty, price: body.limitPrice ?? null, snapshotTs: snapshot.ts },
            }).catch(() => {});

            for (const fill of result.fills) {
                recordEvent({
                    eventType: "TRADE_EXECUTED",
                    entityType: "TRADE",
                    entityId: fill.id,
                    actorUserId: userId,
                    payload: { price: fill.price, qty: fill.qty, fee: fill.fee_amount, executedAt: fill.executed_at },
                }).catch(() => {});
            }

                // ── Post-fill: write rich portfolio snapshot ──
                const lastFill = result.fills[result.fills.length - 1];
                const lastFillTs = new Date(lastFill.executed_at).getTime();
                writePortfolioSnapshot(userId, lastFillTs, body.pairId, lastFill.price)
                    .catch((err) => logger.warn({ err, userId }, "portfolio_snapshot_failed"));

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

        // ── Emit order.updated (no fills, with idempotency) ──
        try {
            publish(createEvent("order.updated", {
                orderId: result.order.id,
                pairId: body.pairId,
                side: body.side,
                type: body.type,
                status: result.order.status,
                qty: body.qty,
                filledQty: result.order.qty_filled,
                limitPrice: body.limitPrice ?? null,
            }, { userId, requestId }));
            eventsPublishedTotal.inc({ type: "order.updated" });
        } catch {
            // Events must never break the order flow
        }

        // ── Event stream: order placed (fire-and-forget) ──
        recordEvent({
            eventType: "ORDER_PLACED",
            entityType: "ORDER",
            entityId: result.order.id,
            actorUserId: userId,
            payload: { side: body.side, type: body.type, qty: body.qty, price: body.limitPrice ?? null, snapshotTs: snapshot.ts },
        }).catch(() => {});

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

    // ── Emit order.updated for no-fills, no-idempotency path ──
    if (result.fills.length === 0 && !idempotencyKey) {
        try {
            publish(createEvent("order.updated", {
                orderId: result.order.id,
                pairId: body.pairId,
                side: body.side,
                type: body.type,
                status: result.order.status,
                qty: body.qty,
                filledQty: result.order.qty_filled,
                limitPrice: body.limitPrice ?? null,
            }, { userId, requestId }));
            eventsPublishedTotal.inc({ type: "order.updated" });
        } catch {
            // Events must never break the order flow
        }

        // ── Event stream: order placed (fire-and-forget) ──
        recordEvent({
            eventType: "ORDER_PLACED",
            entityType: "ORDER",
            entityId: result.order.id,
            actorUserId: userId,
            payload: { side: body.side, type: body.type, qty: body.qty, price: body.limitPrice ?? null, snapshotTs: snapshot.ts },
        }).catch(() => {});
    }

    ordersCreatedTotal.inc();
    orderPlacementLatency.observe(performance.now() - startMs);
    logger.info({ ...logCtx, orderId: result.order.id, eventType: "order.placement_complete", fills: result.fills.length }, "Order placement complete");

    return {
        order: result.order,
        fills: result.fills,
        snapshot,
        fromIdempotencyCache: false,
    };
}

