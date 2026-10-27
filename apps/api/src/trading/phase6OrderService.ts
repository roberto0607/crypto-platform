import { pool } from "../db/pool";
import { getSnapshotForUser } from "../replay/replayEngine";
import { placeOrderTx, cancelOrderTx, cancelReduceOnlyOrdersTx, type CanceledMaker, type CanceledReduceOnly } from "./matchingEngine";
import { computeFee } from "./feeCalc";
import { applyFillToPositionTx } from "../analytics/positionRepo";
import { getIdempotencyKey, putIdempotencyKeyTx } from "./idempotencyRepo";
import { findOrderById } from "./orderRepo";
import { listTradesByOrderId } from "./tradeRepo";
import { findPairById } from "./pairRepo";
import type { OrderRow } from "./orderRepo";
import type { TradeRow } from "./tradeRepo";
import type { Snapshot } from "../market/snapshotStore";
import { getLatestSimCandle } from "../sim/simCandleRepo";
import { D, toFixed8 } from "../utils/decimal";
import { AppError } from "../errors/AppError";
import { createEvent } from "../events/eventTypes";
import {
    closedTriggerSide,
    cancelTriggersForClosedPositionTx,
    triggerCanceledEvent,
    POSITION_CLOSED_REASON,
} from "../triggers/positionCloseTriggers";
import { buildLogContext, logger } from "../observability/logContext";
import {
  marketFillOffBookTotal,
  orderPlacementLatency,
  ordersCreatedTotal,
  ordersRejectedTotal,
} from "../metrics";
import { writePortfolioSnapshotTx } from "../portfolio/portfolioService";
import { walletUpdatedEventsTx } from "../wallets/walletRepo";
import { resolveSimulationConfig } from "../sim/simConfigRepo";
import { computeMarketExecution } from "../sim/slippageModel";
import { computeAvailableLiquidity } from "../sim/liquidityModel";
import { insertOutboxEventTx } from "../outbox/outboxRepo";
import { timedQuery } from "../observability/dbTiming";
import { txWithEvents } from "../utils/txWithEvents";
import { processFillForJournal, type CloseReason } from "../journal/journalService";
import { isAgentActionsEnabled } from "../system/systemFlagService";
import { listOpenOrders } from "./orderRepo";
import { bookSnapshots } from "../market/orderFlowFeatures";
import { buildFillPriceAudit } from "./fillPriceAudit";
import type { CollarReference } from "./priceCollar";
import { recordExecutedTx, type LiquidationFill, type LiquidationRequest } from "./liquidation";

export type PlaceOrderResult = {
    order: OrderRow;
    fills: TradeRow[];
    snapshot: Snapshot;
    fromIdempotencyCache: boolean;
    /** Set when the order was a liquidation: what it booked, and its liquidations row. */
    liquidation?: LiquidationFill & { liquidationId: string };
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
        /** Requested leverage (omitted = 1x, or the leverage already in force). */
        leverage?: number;
        /**
         * Only shrink the position (MARKET only): trimmed to it under the pair
         * lock, reduce_only_no_position when nothing is left. The CLOSE
         * button and every trigger's derived MARKET order send it.
         */
        reduceOnly?: boolean;
        /**
         * Why a fill that closes a position closed it, for the journal
         * (closed_trades.close_reason). Set by the trigger engine; never
         * from the HTTP body. Default MANUAL; a liquidation is LIQUIDATION.
         */
        closeReason?: CloseReason;
    },
    idempotencyKey?: string,
    requestId?: string,
    competitionId?: string | null,
    // matchId is resolved by the caller (HTTP edge / triggers / bots), never here:
    //   null   → free-play (bots, sim, or no active match)
    //   string → that match
    // An omitted arg defaults to free-play. There is deliberately no
    // server-side re-resolution — see resolvedMatchId below.
    matchId?: string | null,
    // Provenance tag. Omitted/null = manual user order — every existing
    // caller (HTTP route, market-maker bot, trigger engine, sim script)
    // is unaffected by this param and the kill-switch check below. Only
    // 'agent' is gated; 'liquidation' is the liquidation engine (below).
    source?: string | null,
    // The liquidation engine's close (liquidationEngine.ts): a MARKET order
    // priced off the live Kraken book only (no replay pricing, no sim
    // liquidity check, which could otherwise refuse it). The matching engine
    // re-checks the position under its locks; the liquidations row is
    // written in this same transaction.
    liquidation?: LiquidationRequest,
): Promise<PlaceOrderResult> {
    const startMs = performance.now();

    // matchId arrives pre-resolved and is used verbatim. No getActiveMatchIdForUser
    // fallback: a null where a match was expected must surface as the symptom
    // (match_id = NULL) rather than be silently re-resolved and mask the bug.
    const resolvedMatchId: string | null = matchId ?? null;
    const resolvedSource: string | null = source ?? null;

    const logCtx = buildLogContext({
      requestId: requestId ?? "no-request",
      userId,
      pairId: body.pairId,
      idempotencyKey,
    });
    logger.info(
        { ...logCtx, eventType: "order.placement_started", matchId: resolvedMatchId, source: resolvedSource },
        "Order placement started",
    );

    // ── 0. Kill switch (agent orders only — manual trading unaffected) ──
    if (resolvedSource === "agent") {
        const enabled = await isAgentActionsEnabled();
        if (!enabled) {
            ordersRejectedTotal.inc({ reason: "agent_actions_disabled" });
            logger.warn({ ...logCtx, eventType: "order.rejected", reason: "agent_actions_disabled" },
                "Order rejected: agent actions disabled");
            orderPlacementLatency.observe(performance.now() - startMs);
            throw new AppError("agent_actions_disabled");
        }
    }

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
    // Live MARKET orders are priced by the matching engine from the real Kraken
    // touch (priceCollar.getMarketReference); the sim model here only sizes the
    // liquidity check. A solo replay session is the exception: its orders price
    // off the historical candle via the sim model, passed down as `replayPricing`.
    let replayPricing: CollarReference | undefined;
    if (body.type === "MARKET" && !liquidation) {
        const simConfig = await resolveSimulationConfig(userId, body.pairId);

        // 1m-pinned, index-served candle for the sim. null when the pair has no
        // 1m candle; computeMarketExecution below handles null volume/high/low
        // (falls back to default simulation) rather than rejecting the order.
        // See simCandleRepo / docs/designs/2026-05-27-candles-query-index.md.
        const candle = await getLatestSimCandle(body.pairId, snapshot.ts);

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

        if (snapshot.source === "replay") {
            const px = D(simResult.execPrice);
            replayPricing = { bestBid: px, bestAsk: px, ageMs: 0, source: "replay" };
        }
    }

    // ── 3–8. Single transaction: risk + matching + post-fill ──
    const { result, idempotencyRowCount, liquidationId } = await txWithEvents(async (client, pendingEvents) => {
        let idempRowCount = 1;

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
            resolvedSource,
            replayPricing,
            body.leverage ?? null,
            liquidation,
            body.reduceOnly ?? false,
        );
        // A reduce-only order may have been trimmed to the position.
        if (body.reduceOnly && matchResult.order.qty !== body.qty) {
            body = { ...body, qty: matchResult.order.qty };
        }
        const takerCloseReason: CloseReason = liquidation ? "LIQUIDATION" : body.closeReason ?? "MANUAL";
        // A trigger's order remembers why it closes, for a later maker fill
        // of its resting remainder (a TP/SL limit).
        if (body.closeReason && body.closeReason !== "MANUAL") {
            await client.query(`UPDATE orders SET close_reason = $2 WHERE id = $1`, [matchResult.order.id, body.closeReason]);
        }
        // Resting orders this order canceled (fill-time checks, or the
        // reduce-only orders of positions it closed), for events below.
        const canceledOrders: (CanceledMaker | CanceledReduceOnly)[] = [...(matchResult.canceledMakers ?? [])];

        // A liquidation closes the position's size at the time of the lock,
        // whatever the engine's candidate said.
        let liquidationId: string | null = null;
        if (matchResult.liquidation) {
            body = { ...body, side: matchResult.order.side as "BUY" | "SELL", qty: matchResult.order.qty };
            liquidationId = await recordExecutedTx(client, matchResult.liquidation, matchResult.order.id);
            const f = matchResult.liquidation;
            pendingEvents.push(createEvent("position.liquidated", {
                liquidationId,
                orderId: matchResult.order.id,
                pairId: f.pairId,
                competitionId: f.scope.competitionId,
                matchId: f.scope.matchId,
                side: f.side,
                qty: f.qty,
                entryPrice: f.entry,
                leverage: f.leverage,
                margin: f.margin,
                liqPrice: f.liqPrice,
                markPrice: f.mark,
                fillPrice: f.fillPrice,
                realizedPnl: f.realizedPnl,
                fee: f.fee,
                returnedEquity: f.returnedEquity,
                shortfall: f.shortfall,
            }, { userId, requestId }));
        }

        // ── 5. Post-fill processing ──
        if (matchResult.fills.length > 0) {
            const pair = await findPairById(body.pairId);
            if (pair) {
                // Positions this order closed (taker or maker side), keyed
                // user:triggerSide:scope — the protective triggers in that
                // scope are canceled after all fills are applied (see
                // positionCloseTriggers.ts).
                type ClosedPosition = {
                    userId: string;
                    triggerSide: "BUY" | "SELL";
                    scope: { competitionId: string | null; matchId: string | null };
                };
                const closedPositions = new Map<string, ClosedPosition>();
                const noteClose = (
                    uid: string,
                    fillSide: "BUY" | "SELL",
                    qty: string,
                    afterQty: string,
                    scope: ClosedPosition["scope"],
                ) => {
                    const triggerSide = closedTriggerSide(fillSide, qty, afterQty);
                    if (triggerSide) {
                        closedPositions.set(
                            `${uid}:${triggerSide}:${scope.competitionId ?? ""}:${scope.matchId ?? ""}`,
                            { userId: uid, triggerSide, scope },
                        );
                    }
                };

                for (const fill of matchResult.fills) {
                    const fillPrice = fill.price;
                    const fillQty = fill.qty;
                    const quoteAmount = fill.quote_amount;
                    const executedAtMs = new Date(fill.executed_at).getTime();

                    // Same function + same rounded quote amount the matching
                    // engine charged the wallet with — positions, journal and
                    // ledger can't diverge.
                    const takerFee = computeFee(quoteAmount, "TAKER", pair, userId);

                    // Apply fill to taker's position. An ISOLATED leg was
                    // already applied by the matching engine (its USD moves
                    // depend on the position) — never apply it twice.
                    const takerIso = matchResult.isolatedLegs?.get(`${fill.id}:TAKER`);
                    const takerBaseQty = takerIso
                        ? takerIso.baseQtyAfter
                        : (await applyFillToPositionTx(client, {
                            userId,
                            pairId: body.pairId,
                            side: body.side,
                            qty: fillQty,
                            price: fillPrice,
                            feeQuote: takerFee.feeAmount,
                            ts: executedAtMs,
                            competitionId,
                            matchId: resolvedMatchId,
                        })).base_qty;
                    noteClose(userId, body.side, fillQty, takerBaseQty, { competitionId: competitionId ?? null, matchId: resolvedMatchId });

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
                        feeQuote: takerIso ? takerIso.feeBooked : takerFee.feeAmount,
                        filledAt: new Date(fill.executed_at),
                        competitionId: competitionId ?? null,
                        closeReason: takerCloseReason,
                        isolated: takerIso?.reduce,
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
                        let makerCloseReason: CloseReason = "MANUAL";
                        if (makerOrderId) {
                            const makerResult = await timedQuery<{
                                user_id: string;
                                competition_id: string | null;
                                match_id: string | null;
                                close_reason: CloseReason | null;
                            }>(client, "phase6OrderService.placeOrderWithSnapshot.makerOrderLookup",
                                `SELECT user_id, competition_id, match_id, close_reason
                                 FROM orders WHERE id = $1`,
                                [makerOrderId]
                            );
                            const makerRow = makerResult.rows[0];
                            if (makerRow) {
                                makerUserId = makerRow.user_id;
                                makerCompetitionId = makerRow.competition_id;
                                makerMatchId = makerRow.match_id;
                                makerCloseReason = makerRow.close_reason ?? "MANUAL";
                            }
                        }

                        if (makerUserId) {
                            const makerSide = body.side === "BUY" ? "SELL" : "BUY";
                            const makerFee = computeFee(quoteAmount, "MAKER", pair, makerUserId);

                            const makerIso = matchResult.isolatedLegs?.get(`${fill.id}:MAKER`);
                            const makerBaseQty = makerIso
                                ? makerIso.baseQtyAfter
                                : (await applyFillToPositionTx(client, {
                                    userId: makerUserId,
                                    pairId: body.pairId,
                                    side: makerSide as "BUY" | "SELL",
                                    qty: fillQty,
                                    price: fillPrice,
                                    feeQuote: makerFee.feeAmount,
                                    ts: executedAtMs,
                                    competitionId: makerCompetitionId,
                                    matchId: makerMatchId,
                                })).base_qty;
                            noteClose(makerUserId, makerSide as "BUY" | "SELL", fillQty, makerBaseQty, {
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
                                feeQuote: makerIso ? makerIso.feeBooked : makerFee.feeAmount,
                                filledAt: new Date(fill.executed_at),
                                competitionId: makerCompetitionId,
                                // A resting order the user placed (their own
                                // close), or a resting TP/SL limit.
                                closeReason: makerCloseReason,
                                isolated: makerIso?.reduce,
                            });
                        }
                    }
                }

                // ── Cancel triggers protecting positions this order closed ──
                // ... and their resting reduce-only orders (a TP/SL limit), so
                // none can fill later and open or flip a position.
                for (const { userId: closedUserId, triggerSide, scope } of closedPositions.values()) {
                    const canceled = await cancelTriggersForClosedPositionTx(client, closedUserId, body.pairId, triggerSide, scope);
                    for (const row of canceled) pendingEvents.push(triggerCanceledEvent(row, POSITION_CLOSED_REASON));
                    canceledOrders.push(...await cancelReduceOnlyOrdersTx(client, closedUserId, body.pairId, triggerSide, scope));
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

        // Resting orders this order canceled: at fill time (an ISOLATED
        // opening part over the cap or unfunded, a reduce-only one with
        // nothing left to reduce), or a closed position's reduce-only
        // orders. Tell their owners.
        for (const c of canceledOrders) {
            await insertOutboxEventTx(client, {
                event_type: "EVENT_STREAM_APPEND",
                aggregate_type: "ORDER",
                aggregate_id: c.order.id,
                payload: {
                    eventInput: {
                        eventType: "ORDER_CANCELLED",
                        entityType: "ORDER",
                        entityId: c.order.id,
                        actorUserId: c.order.user_id,
                        payload: { pairId: c.order.pair_id, releasedAmount: c.releasedAmount, reason: c.reason },
                    },
                },
            });
            pendingEvents.push(createEvent("order.updated", {
                orderId: c.order.id,
                pairId: c.order.pair_id,
                side: c.order.side as "BUY" | "SELL",
                type: c.order.type as "MARKET" | "LIMIT",
                status: c.order.status,
                qty: c.order.qty,
                filledQty: c.order.qty_filled,
                limitPrice: c.order.limit_price ?? null,
            }, { userId: c.order.user_id, requestId }));
        }

        // Balances this order moved — the taker's and every maker's — so each
        // owner's AVAILABLE updates live (fill, limit hold).
        pendingEvents.push(...await walletUpdatedEventsTx(
            client, matchResult.walletIds, matchResult.fills.length > 0 ? "TRADE" : "ORDER_RESERVE",
        ));

        return { result: matchResult, idempotencyRowCount: idempRowCount, liquidationId };
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

    // Diagnostic only (2026-10-01 bad-fill investigation): record every input
    // to the MARKET fill price next to the Kraken book the user was looking
    // at. Never affects the order — any failure here is swallowed.
    if (body.type === "MARKET" && result.fills.length > 0) {
        try {
            const audit = buildFillPriceAudit({
                side: body.side,
                snapshot,
                reference: result.reference,
                fills: result.fills,
                book: bookSnapshots.get(body.pairId),
                now: Date.now(),
            });
            if (audit.offBook) marketFillOffBookTotal.inc({ side: body.side, direction: audit.offBook });
            logger.info({ ...logCtx, orderId: result.order.id, eventType: "order.fill_price_audit", ...audit }, "Market fill price audit");
        } catch (err) {
            logger.warn({ ...logCtx, err }, "fill_price_audit_failed");
        }
    }

    return {
        order: result.order,
        fills: result.fills,
        snapshot,
        fromIdempotencyCache: false,
        ...(result.liquidation && liquidationId ? { liquidation: { ...result.liquidation, liquidationId } } : {}),
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

        pendingEvents.push(...await walletUpdatedEventsTx(client, releasedWalletIds([cancelResult]), "ORDER_RELEASE"));

        return cancelResult;
    });
}

/** Wallets whose hold a cancel released (nothing released → no balance change). */
function releasedWalletIds(results: { order: OrderRow; releasedAmount: string }[]): string[] {
    return results
        .filter((r) => r.order.reserved_wallet_id && D(r.releasedAmount).gt(0))
        .map((r) => r.order.reserved_wallet_id!);
}

/**
 * Bulk-cancel open/partial orders matching the given filters, in one
 * transaction. Used by the admin cancel-all kill-switch endpoint
 * (POST /v1/admin/orders/cancel-all) — see betaAdminRoutes.ts.
 *
 * Each order is canceled via the same cancelOrderTx() a single-order
 * cancel uses, passing that order's own owning user_id (not the admin's)
 * so the ownership check inside cancelOrderInternal passes naturally.
 * A race loss on one order (e.g. it filled between listOpenOrders() and
 * this transaction starting) is skipped rather than aborting the whole
 * batch — cancelOrderTx's "order_not_cancelable" is a plain JS throw, not
 * a failed SQL statement, so catching it here does not poison the
 * surrounding Postgres transaction.
 */
export async function cancelAllOrdersWithOutbox(
    filters: { pairId?: string; userId?: string; source?: string },
    requestId?: string,
): Promise<{
    canceled: { order: OrderRow; releasedAmount: string }[];
    skipped: { orderId: string; reason: string }[];
}> {
    const openOrders = await listOpenOrders(filters);

    return txWithEvents(async (client, pendingEvents) => {
        const canceled: { order: OrderRow; releasedAmount: string }[] = [];
        const skipped: { orderId: string; reason: string }[] = [];

        for (const order of openOrders) {
            let cancelResult: { order: OrderRow; releasedAmount: string };
            try {
                cancelResult = await cancelOrderTx(client, order.user_id, order.id);
            } catch (err) {
                skipped.push({ orderId: order.id, reason: err instanceof Error ? err.message : "unknown_error" });
                continue;
            }

            await insertOutboxEventTx(client, {
                event_type: "EVENT_STREAM_APPEND",
                aggregate_type: "ORDER",
                aggregate_id: order.id,
                payload: {
                    eventInput: {
                        eventType: "ORDER_CANCELLED",
                        entityType: "ORDER",
                        entityId: order.id,
                        actorUserId: order.user_id,
                        payload: {
                            pairId: cancelResult.order.pair_id,
                            releasedAmount: cancelResult.releasedAmount,
                        },
                    },
                },
            });

            pendingEvents.push(createEvent("order.updated", {
                orderId: order.id,
                pairId: cancelResult.order.pair_id,
                side: cancelResult.order.side as "BUY" | "SELL",
                type: cancelResult.order.type as "MARKET" | "LIMIT",
                status: cancelResult.order.status,
                qty: cancelResult.order.qty,
                filledQty: cancelResult.order.qty_filled,
                limitPrice: cancelResult.order.limit_price ?? null,
            }, { userId: order.user_id, requestId }));

            canceled.push(cancelResult);
        }

        pendingEvents.push(...await walletUpdatedEventsTx(client, releasedWalletIds(canceled), "ORDER_RELEASE"));

        return { canceled, skipped };
    });
}
