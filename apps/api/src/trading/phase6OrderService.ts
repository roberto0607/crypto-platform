import { pool } from "../db/pool";
import { getSnapshotForUser } from "../replay/replayEngine";
import { placeOrderTx, cancelOrderTx } from "./matchingEngine";
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
import { AppError } from "../errors/AppError";
import { createEvent } from "../events/eventTypes";
import { buildLogContext, logger } from "../observability/logContext";
import {
  orderPlacementLatency,
  ordersCreatedTotal,
  ordersRejectedTotal,
} from "../metrics";
import { writePortfolioSnapshotTx } from "../portfolio/portfolioService";
import { resolveSimulationConfig } from "../sim/simConfigRepo";
import { computeMarketExecution } from "../sim/slippageModel";
import { computeAvailableLiquidity } from "../sim/liquidityModel";
import { insertOutboxEventTx } from "../outbox/outboxRepo";
import { txWithEvents } from "../utils/txWithEvents";
import { processFillForJournal } from "../journal/journalService";
import { getActiveMatchIdForUser } from "../competitions/matchService";

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
 *   3. Single transaction: risk checks + matching + positions + outbox + idempotency
 *   4. After commit: SSE events + portfolio snapshot
 *
 * All database writes happen in a SINGLE transaction.
 * SSE events and portfolio snapshots fire after COMMIT.
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
    requestId?: string,
    competitionId?: string | null,
    // matchId semantics:
    //   undefined → server resolves via getActiveMatchIdForUser (default for HTTP)
    //   null      → explicit free-play (used by bots/sim)
    //   string    → caller-specified match (used by Redis queue replay)
    matchId?: string | null,
): Promise<PlaceOrderResult> {
    const startMs = performance.now();

    // Resolve matchId: caller-supplied wins, else look up user's active match.
    // Distinguish undefined (do lookup) from null (explicit free-play) — bots
    // and the redis queue replay path both pass null to opt out of the lookup.
    const resolvedMatchId: string | null =
        matchId !== undefined
            ? matchId
            : await getActiveMatchIdForUser(userId);

    const logCtx = buildLogContext({
      requestId: requestId ?? "no-request",
      userId,
      pairId: body.pairId,
      idempotencyKey,
    });
    logger.info(
        { ...logCtx, eventType: "order.placement_started", matchId: resolvedMatchId },
        "Order placement started",
    );

    // ── 1. Idempotency check (outside transaction) ──
    if (idempotencyKey) {
        const existing = await getIdempotencyKey(userId, idempotencyKey);
        if (existing) {
            const order = await findOrderById(existing.order_id);
            const fills = order ? await listTradesByOrderId(order.id) : [];
            const snap = existing.snapshot_json as Snapshot;
            logger.info({ ...logCtx, eventType: "order.idempotency_hit" }, "Idempotency cache hit");
            orderPlacementLatency.observe(performance.now() - startMs);
            return {
                order: order!,
                fills,
                snapshot: snap,
                fromIdempotencyCache: true,
            };
        }
    }

    // ── 2. Resolve snapshot (outside transaction) ──
    const snapshot = await resolveSnapshot(userId, body.pairId);
    // ── 2c. Simulation reads (MARKET only, outside transaction) ──
    let simExecPrice: string | null = null;
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
        // Defensive: `candleRows[0] ?? null` was already safe from TypeError.
        // computeMarketExecution below handles null volume/high/low (treats as
        // missing and falls back to default simulation), so we keep that
        // behavior rather than rejecting orders on pairs with no candle history.
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

        simExecPrice = simResult.execPrice;
    }

    // ── 3–8. Single transaction: risk + matching + post-fill ──
    const { result, idempotencyRowCount } = await txWithEvents(async (client, pendingEvents) => {
        let idempRowCount = 1;

        // ── Simulation UPDATE (inside transaction) ──
        if (simExecPrice) {
            await client.query(
                `UPDATE trading_pairs SET last_price = $1 WHERE id = $2`,
                [simExecPrice, body.pairId]
            );
        }

        // ── 4. Match (within caller's transaction) ──
        const matchResult = await placeOrderTx(
            client,
            userId,
            body.pairId,
            body.side,
            body.type,
            body.qty,
            body.limitPrice,
            competitionId,
            resolvedMatchId,
        );

        // ── 5. Post-fill processing ──
        if (matchResult.fills.length > 0) {
            const pair = await findPairById(body.pairId);
            if (pair) {
                for (const fill of matchResult.fills) {
                    const fillPrice = fill.price;
                    const fillQty = fill.qty;
                    const quoteAmount = fill.quote_amount;
                    const executedAtMs = new Date(fill.executed_at).getTime();

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
                        competitionId,
                        matchId: resolvedMatchId,
                    });

                    // Journal: record taker fill for FIFO P&L.
                    // NOTE: open_lots / closed_trades don't have match_id
                    // columns yet (see migration 066 paired-changes list);
                    // journal stays competition-scoped-only for now.
                    await processFillForJournal(client, {
                        userId,
                        pairId: body.pairId,
                        fillId: fill.id,
                        side: body.side,
                        price: fillPrice,
                        qty: fillQty,
                        feeQuote: takerFee.feeAmount,
                        filledAt: new Date(fill.executed_at),
                        competitionId: competitionId ?? null,
                    });

                    // Apply fill to maker's position (if not system fill).
                    // Bug L3 fix: maker's scope comes from the order they
                    // originally placed (makerOrder.competition_id /
                    // .match_id), NOT the taker's incoming scope. Otherwise
                    // a match-scoped taker would clobber the maker's
                    // free-play position row (or vice versa).
                    if (!fill.is_system_fill) {
                        const makerOrderId = body.side === "BUY" ? fill.sell_order_id : fill.buy_order_id;
                        let makerUserId: string | null = null;
                        let makerCompetitionId: string | null = null;
                        let makerMatchId: string | null = null;
                        if (makerOrderId) {
                            const makerResult = await client.query<{
                                user_id: string;
                                competition_id: string | null;
                                match_id: string | null;
                            }>(
                                `SELECT user_id, competition_id, match_id
                                 FROM orders WHERE id = $1`,
                                [makerOrderId]
                            );
                            const makerRow = makerResult.rows[0];
                            if (makerRow) {
                                makerUserId = makerRow.user_id;
                                makerCompetitionId = makerRow.competition_id;
                                makerMatchId = makerRow.match_id;
                            }
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
                                competitionId: makerCompetitionId,
                                matchId: makerMatchId,
                            });

                            // Journal maker fill — same journal-scope caveat
                            // as the taker journal call above.
                            await processFillForJournal(client, {
                                userId: makerUserId,
                                pairId: body.pairId,
                                fillId: fill.id,
                                side: makerSide as "BUY" | "SELL",
                                price: fillPrice,
                                qty: fillQty,
                                feeQuote: makerFee.feeAmount,
                                filledAt: new Date(fill.executed_at),
                                competitionId: makerCompetitionId,
                            });
                        }
                    }
                }

                // ── Idempotency key ──
                if (idempotencyKey) {
                    idempRowCount = await putIdempotencyKeyTx(client, userId, idempotencyKey, matchResult.order.id, snapshot);
                }

                // ── Outbox: ORDER_PLACED ──
                await insertOutboxEventTx(client, {
                    event_type: "EVENT_STREAM_APPEND",
                    aggregate_type: "ORDER",
                    aggregate_id: matchResult.order.id,
                    payload: {
                        eventInput: {
                            eventType: "ORDER_PLACED",
                            entityType: "ORDER",
                            entityId: matchResult.order.id,
                            actorUserId: userId,
                            payload: { side: body.side, type: body.type, qty: body.qty, price: body.limitPrice ?? null, snapshotTs: snapshot.ts },
                        },
                    },
                });

                // ── Outbox: TRADE_EXECUTED per fill ──
                for (const fill of matchResult.fills) {
                    await insertOutboxEventTx(client, {
                        event_type: "EVENT_STREAM_APPEND",
                        aggregate_type: "TRADE",
                        aggregate_id: fill.id,
                        payload: {
                            eventInput: {
                                eventType: "TRADE_EXECUTED",
                                entityType: "TRADE",
                                entityId: fill.id,
                                actorUserId: userId,
                                payload: { price: fill.price, qty: fill.qty, fee: fill.fee_amount, executedAt: fill.executed_at },
                            },
                        },
                    });
                }

                // ── Portfolio snapshot (inside transaction, sees uncommitted wallet/position changes) ──
                const lastFill = matchResult.fills[matchResult.fills.length - 1];
                const lastFillTs = new Date(lastFill.executed_at).getTime();
                await writePortfolioSnapshotTx(client, userId, lastFillTs, body.pairId, lastFill.price, competitionId, resolvedMatchId);
            }

            // Prepare SSE events (published after commit)
            pendingEvents.push(createEvent("order.updated", {
                orderId: matchResult.order.id,
                pairId: body.pairId,
                side: body.side,
                type: body.type,
                status: matchResult.order.status,
                qty: body.qty,
                filledQty: matchResult.order.qty_filled,
                limitPrice: body.limitPrice ?? null,
            }, { userId, requestId }));

            for (const fill of matchResult.fills) {
                pendingEvents.push(createEvent("trade.created", {
                    tradeId: fill.id,
                    orderId: matchResult.order.id,
                    pairId: body.pairId,
                    side: body.side,
                    price: fill.price,
                    qty: fill.qty,
                    quoteAmount: fill.quote_amount,
                }, { userId, requestId }));
            }
        } else if (idempotencyKey) {
            // No fills, has idempotency key
            idempRowCount = await putIdempotencyKeyTx(client, userId, idempotencyKey, matchResult.order.id, snapshot);

            await insertOutboxEventTx(client, {
                event_type: "EVENT_STREAM_APPEND",
                aggregate_type: "ORDER",
                aggregate_id: matchResult.order.id,
                payload: {
                    eventInput: {
                        eventType: "ORDER_PLACED",
                        entityType: "ORDER",
                        entityId: matchResult.order.id,
                        actorUserId: userId,
                        payload: { side: body.side, type: body.type, qty: body.qty, price: body.limitPrice ?? null, snapshotTs: snapshot.ts },
                    },
                },
            });

            pendingEvents.push(createEvent("order.updated", {
                orderId: matchResult.order.id,
                pairId: body.pairId,
                side: body.side,
                type: body.type,
                status: matchResult.order.status,
                qty: body.qty,
                filledQty: matchResult.order.qty_filled,
                limitPrice: body.limitPrice ?? null,
            }, { userId, requestId }));
        } else {
            // No fills, no idempotency
            await insertOutboxEventTx(client, {
                event_type: "EVENT_STREAM_APPEND",
                aggregate_type: "ORDER",
                aggregate_id: matchResult.order.id,
                payload: {
                    eventInput: {
                        eventType: "ORDER_PLACED",
                        entityType: "ORDER",
                        entityId: matchResult.order.id,
                        actorUserId: userId,
                        payload: { side: body.side, type: body.type, qty: body.qty, price: body.limitPrice ?? null, snapshotTs: snapshot.ts },
                    },
                },
            });

            pendingEvents.push(createEvent("order.updated", {
                orderId: matchResult.order.id,
                pairId: body.pairId,
                side: body.side,
                type: body.type,
                status: matchResult.order.status,
                qty: body.qty,
                filledQty: matchResult.order.qty_filled,
                limitPrice: body.limitPrice ?? null,
            }, { userId, requestId }));
        }

        return { result: matchResult, idempotencyRowCount: idempRowCount };
    });

    // ── Idempotency race recovery (after commit) ──
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

/**
 * Cancel an open/partial order with outbox event in a single transaction.
 *
 * Wraps cancelOrderTx + outbox insertion so the ORDER_CANCELLED event
 * is guaranteed to be recorded atomically with the cancellation.
 * SSE event fires after COMMIT via txWithEvents.
 */
export async function cancelOrderWithOutbox(
    userId: string,
    orderId: string,
    requestId?: string,
): Promise<{ order: OrderRow; releasedAmount: string }> {
    return txWithEvents(async (client, pendingEvents) => {
        const cancelResult = await cancelOrderTx(client, userId, orderId);

        await insertOutboxEventTx(client, {
            event_type: "EVENT_STREAM_APPEND",
            aggregate_type: "ORDER",
            aggregate_id: orderId,
            payload: {
                eventInput: {
                    eventType: "ORDER_CANCELLED",
                    entityType: "ORDER",
                    entityId: orderId,
                    actorUserId: userId,
                    payload: {
                        pairId: cancelResult.order.pair_id,
                        releasedAmount: cancelResult.releasedAmount,
                    },
                },
            },
        });

        pendingEvents.push(createEvent("order.updated", {
            orderId,
            pairId: cancelResult.order.pair_id,
            side: cancelResult.order.side as "BUY" | "SELL",
            type: cancelResult.order.type as "MARKET" | "LIMIT",
            status: cancelResult.order.status,
            qty: cancelResult.order.qty,
            filledQty: cancelResult.order.qty_filled,
            limitPrice: cancelResult.order.limit_price ?? null,
        }, { userId, requestId }));

        return cancelResult;
    });
}
