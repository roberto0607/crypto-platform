import { pool } from "../db/pool";
import { listActiveTriggersForPair, markTriggeredTx, cancelOcoSiblingTx, setStatusTx, updateTrailingHwm, reducibleQty } from "./triggerRepo";
import { triggerCanceledEvent, MATCH_ENDED_REASON } from "./positionCloseTriggers";
import Decimal from "decimal.js";
import { D, toFixed8 } from "../utils/decimal";
import type { TriggerOrderRow } from "./triggerTypes";
import { placeOrderWithSnapshot } from "../trading/phase6OrderService";
import { subscribeGlobal, unsubscribe, publish } from "../events/eventBus";
import type { EventHandler } from "../events/eventBus";
import { createEvent } from "../events/eventTypes";
import { findPairById } from "../trading/pairRepo";
import { logger } from "../observability/logContext";
import { notifyTriggerFired } from "../notifications/notificationService";
import type { CloseReason } from "../journal/journalService";

type PriceSnapshot = { last: string };

let handler: EventHandler | null = null;

/**
 * A MARKET order is rejected with stale_price_source while the Kraken book (the
 * price-collar reference) is stale — a transient feed condition, not a verdict
 * on the trigger. Such a trigger is re-armed rather than FAILED, and not
 * re-fired until this backoff passes so a feed outage doesn't turn every tick
 * into an order attempt.
 */
export const STALE_REARM_BACKOFF_MS = 2_000;
const rearmedUntil = new Map<string, number>();

/**
 * Pure crossing check — deterministic given (trigger, snapshot).
 *
 * STOP BUY  / TP SELL  → fire when last >= trigger_price
 * STOP SELL / TP BUY   → fire when last <= trigger_price
 * TRAILING_STOP_MARKET  → trigger_price is dynamically updated by updateTrailingStop
 */
export function shouldTrigger(
    trigger: TriggerOrderRow,
    snapshot: PriceSnapshot
): boolean {
    const last = parseFloat(snapshot.last);
    const tp = parseFloat(trigger.trigger_price);

    const isStop = trigger.kind.startsWith("STOP") || trigger.kind === "TRAILING_STOP_MARKET";
    const isBuy = trigger.side === "BUY";

    // STOP BUY or TAKE_PROFIT SELL → fire when last >= trigger_price
    // STOP SELL or TAKE_PROFIT BUY → fire when last <= trigger_price
    if ((isStop && isBuy) || (!isStop && !isBuy)) {
        return last >= tp;
    }
    return last <= tp;
}

/**
 * Update trailing stop high water mark and effective trigger price.
 * Called on every price tick BEFORE shouldTrigger check.
 *
 * For SELL trailing stops (long position protection):
 *   hwm = max(hwm, currentPrice), triggerPrice = hwm - offset
 * For BUY trailing stops (short position protection):
 *   hwm = min(hwm, currentPrice), triggerPrice = hwm + offset
 */
async function updateTrailingStop(
    trigger: TriggerOrderRow,
    snapshot: PriceSnapshot,
): Promise<void> {
    if (trigger.kind !== "TRAILING_STOP_MARKET" || !trigger.trailing_offset) return;

    const last = parseFloat(snapshot.last);
    const offset = parseFloat(trigger.trailing_offset);
    const currentHwm = trigger.trailing_high_water_mark ? parseFloat(trigger.trailing_high_water_mark) : last;

    let newHwm: number;
    let newTriggerPrice: number;

    if (trigger.side === "SELL") {
        // Long position: track highest price
        newHwm = Math.max(currentHwm, last);
        newTriggerPrice = newHwm - offset;
    } else {
        // Short position: track lowest price
        newHwm = Math.min(currentHwm, last);
        newTriggerPrice = newHwm + offset;
    }

    if (newHwm !== currentHwm || newTriggerPrice !== parseFloat(trigger.trigger_price)) {
        await updateTrailingHwm(trigger.id, newHwm.toFixed(8), Math.max(0, newTriggerPrice).toFixed(8));
        // Update in-memory for the subsequent shouldTrigger check
        trigger.trailing_high_water_mark = newHwm.toFixed(8);
        trigger.trigger_price = Math.max(0, newTriggerPrice).toFixed(8);
    }
}

/**
 * Two-phase trigger firing:
 *
 * Phase 1 (DB txn):
 *   - SELECT FOR UPDATE the trigger row
 *   - Confirm status = ACTIVE (idempotent guard)
 *   - Mark TRIGGERED
 *   - If OCO: cancel sibling leg
 *
 * Phase 2 (after commit):
 *   - Place derived order via placeOrderWithSnapshot
 *   - On success: record derived_order_id
 *   - On failure: mark FAILED with reason
 */
export async function fireTrigger(
    trigger: TriggerOrderRow,
    snapshot: PriceSnapshot
): Promise<void> {
    const client = await pool.connect();
    let canceledSibling: TriggerOrderRow | null = null;

    try {
        await client.query("BEGIN");

        const locked = await markTriggeredTx(client, trigger.id);
        if (!locked) {
            await client.query("ROLLBACK");
            return; // already triggered or canceled — idempotent
        }

        if (trigger.oco_group_id) {
            canceledSibling = await cancelOcoSiblingTx(
                client,
                trigger.oco_group_id,
                trigger.id
            );
        }

        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK");
        logger.error({ triggerId: trigger.id, err }, "trigger_fire_txn_error");
        return;
    } finally {
        client.release();
    }

    // Phase 2 — place derived order (outside the trigger txn)
    const derivedType = trigger.kind.endsWith("_MARKET") ? "MARKET" : "LIMIT";
    const derivedLimitPrice = derivedType === "LIMIT" ? trigger.limit_price ?? undefined : undefined;

    let derivedOrderId: string | null = null;

    // The derived order acts on the account the trigger was created in
    // (trigger_orders.match_id, null = free-play) — never on whatever match
    // the user happens to be in when it fires. Resolving at fire time sent a
    // free-play stop into a later match wallet and closed the wrong position.
    const triggerMatchId = trigger.match_id;
    if (triggerMatchId !== null && !(await isMatchActive(triggerMatchId))) {
        // The match it protected is over (its positions were force-closed);
        // match end normally cancels these already — this is the backstop.
        await cancelUnfired(trigger, canceledSibling, MATCH_ENDED_REASON);
        return;
    }

    // Reduce-only: a TP/SL/trailing trigger only ever closes the position it
    // protects. Clamp its qty to what's left of that position in the scope the
    // derived order lands in; if nothing is left (closed manually, by the
    // other OCO leg, or partially closed down to zero) cancel instead of
    // placing an order that would open — or flip into — a new position.
    const reducible = D(await reducibleQty(trigger.user_id, trigger.pair_id, trigger.side, {
        competitionId: null,             // derived orders are free-play or match scoped, never competition
        matchId: triggerMatchId,
    }));
    const orderQty = Decimal.min(D(trigger.qty), reducible);
    if (orderQty.lte(0)) {
        await cancelUnfired(trigger, canceledSibling, NO_POSITION_REASON);
        return; // not fired: no order, no trigger.fired event, no notification
    }

    try {
        const result = await placeOrderWithSnapshot(
            trigger.user_id,
            {
                pairId: trigger.pair_id,
                side: trigger.side,
                type: derivedType,
                qty: toFixed8(orderQty),
                limitPrice: derivedLimitPrice,
                // The clamp above read the position without a lock. A MARKET
                // order is also reduce-only under the pair lock, so a close
                // that got there first (the user's, the other leg, a
                // liquidation) can never turn this into a new position. (A
                // LIMIT can't be reduce-only: it may rest.)
                reduceOnly: derivedType === "MARKET",
                closeReason: closeReasonOf(trigger.kind),
            },
            undefined,           // idempotencyKey
            undefined,           // requestId
            undefined,           // competitionId — derived orders inherit free-play competition
            triggerMatchId,      // matchId — the trigger's own scope, never re-resolved
        );

        derivedOrderId = result.order.id;

        // Record derived order ID
        const updateClient = await pool.connect();
        try {
            await updateClient.query("BEGIN");
            await setStatusTx(updateClient, trigger.id, "TRIGGERED", {
                derivedOrderId,
            });
            await updateClient.query("COMMIT");
        } catch (updateErr) {
            await updateClient.query("ROLLBACK");
            logger.error({ triggerId: trigger.id, updateErr }, "trigger_derived_id_update_error");
        } finally {
            updateClient.release();
        }
    } catch (err) {
        if (err instanceof Error && err.message === "stale_price_source") {
            await rearmTrigger(trigger, canceledSibling);
            return; // not fired: no trigger.fired event, no notification
        }
        if (err instanceof Error && err.message === "reduce_only_no_position") {
            // The position closed between the clamp and the pair lock.
            await cancelUnfired(trigger, canceledSibling, NO_POSITION_REASON);
            return; // not fired: no order, no trigger.fired event, no notification
        }

        // Mark FAILED with reason
        const failClient = await pool.connect();
        try {
            await failClient.query("BEGIN");
            await setStatusTx(failClient, trigger.id, "FAILED", {
                failReason: err instanceof Error ? err.message : "unknown_error",
            });
            await failClient.query("COMMIT");
        } catch (failErr) {
            await failClient.query("ROLLBACK");
            logger.error({ triggerId: trigger.id, failErr }, "trigger_fail_status_update_error");
        } finally {
            failClient.release();
        }

        logger.warn({ triggerId: trigger.id, err }, "trigger_derived_order_failed");
    }

    // Publish events (fire-and-forget)
    try {
        publish(createEvent("trigger.fired", {
            triggerId: trigger.id,
            pairId: trigger.pair_id,
            kind: trigger.kind,
            side: trigger.side,
            derivedOrderId,
        }, { userId: trigger.user_id }));
    } catch {
        // Events must never break trigger engine
    }

    // Send in-app notification (fire-and-forget, but log failures)
    findPairById(trigger.pair_id).then((pair) => {
        const symbol = pair?.symbol ?? trigger.pair_id;
        notifyTriggerFired(trigger.user_id, symbol, trigger.kind, trigger.side).catch((err) => {
            logger.error({ err, triggerId: trigger.id }, "trigger_notify_failed");
        });
    }).catch((err) => {
        logger.error({ err, triggerId: trigger.id }, "trigger_notify_failed");
    });

    if (canceledSibling) {
        try {
            publish(createEvent("trigger.canceled", {
                triggerId: canceledSibling.id,
                pairId: canceledSibling.pair_id,
                reason: "oco_sibling_triggered",
            }, { userId: canceledSibling.user_id }));
        } catch {
            // Events must never break trigger engine
        }
    }
}

export const NO_POSITION_REASON = "no_position";

/** closed_trades.close_reason for a trigger's derived order. */
export function closeReasonOf(kind: TriggerOrderRow["kind"]): CloseReason {
    if (kind.startsWith("TRAILING_STOP")) return "TRAILING";
    if (kind.startsWith("TAKE_PROFIT")) return "TP";
    return "SL";
}

/**
 * A trigger that fired but must not trade — nothing left to reduce
 * (no_position), or its match is over (match_ended): record it as CANCELED
 * with that reason rather than TRIGGERED/FAILED. The OCO sibling this firing
 * canceled stays canceled — it protected the same, now absent, position. Only
 * touches the row while it's still in the state fireTrigger left it in.
 */
async function cancelUnfired(trigger: TriggerOrderRow, canceledSibling: TriggerOrderRow | null, reason: string): Promise<void> {
    try {
        const { rows } = await pool.query<TriggerOrderRow>(
            `UPDATE trigger_orders SET status = 'CANCELED', fail_reason = $2
             WHERE id = $1 AND status = 'TRIGGERED' AND derived_order_id IS NULL
             RETURNING id, user_id, pair_id`,
            [trigger.id, reason],
        );
        logger.info({ triggerId: trigger.id, userId: trigger.user_id, pairId: trigger.pair_id, reason }, "trigger_canceled_unfired");
        for (const row of [...rows, ...(canceledSibling ? [canceledSibling] : [])]) {
            try {
                publish(triggerCanceledEvent(row, reason));
            } catch {
                // Events must never break trigger engine
            }
        }
    } catch (err) {
        logger.error({ triggerId: trigger.id, err, reason }, "trigger_unfired_cancel_error");
    }
}

async function isMatchActive(matchId: string): Promise<boolean> {
    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM matches WHERE id = $1`, [matchId]);
    return rows[0]?.status === "ACTIVE";
}

/**
 * Put a trigger (and the OCO sibling this firing canceled) back to ACTIVE so it
 * fires again on a later tick. Only rows still in the state this firing left
 * them in are touched, so a user cancel in between wins.
 */
async function rearmTrigger(trigger: TriggerOrderRow, canceledSibling: TriggerOrderRow | null): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(
            `UPDATE trigger_orders SET status = 'ACTIVE' WHERE id = $1 AND status = 'TRIGGERED' AND derived_order_id IS NULL`,
            [trigger.id],
        );
        if (canceledSibling) {
            await client.query(
                `UPDATE trigger_orders SET status = 'ACTIVE' WHERE id = $1 AND status = 'CANCELED'`,
                [canceledSibling.id],
            );
        }
        await client.query("COMMIT");
        rearmedUntil.set(trigger.id, Date.now() + STALE_REARM_BACKOFF_MS);
        logger.warn(
            { triggerId: trigger.id, siblingId: canceledSibling?.id ?? null, backoffMs: STALE_REARM_BACKOFF_MS },
            "trigger_rearmed_stale_price_source",
        );
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        logger.error({ triggerId: trigger.id, err }, "trigger_rearm_error");
    } finally {
        client.release();
    }
}

/**
 * Evaluate all ACTIVE triggers for a pair against the current price.
 * Fires each trigger that crosses its threshold.
 * Order is deterministic: sorted by created_at ASC, id ASC.
 */
export async function evaluateTriggersForPair(
    pairId: string,
    snapshot: PriceSnapshot
): Promise<void> {
    const triggers = await listActiveTriggersForPair(pairId);

    for (const trigger of triggers) {
        // Update trailing stop HWM before checking
        if (trigger.kind === "TRAILING_STOP_MARKET") {
            await updateTrailingStop(trigger, snapshot);
        }
        if (shouldTrigger(trigger, snapshot)) {
            const until = rearmedUntil.get(trigger.id);
            if (until !== undefined) {
                if (Date.now() < until) continue;
                rearmedUntil.delete(trigger.id);
            }
            await fireTrigger(trigger, snapshot);
        }
    }
}

/**
 * Bootstrap: subscribe to event bus for replay.tick and price.tick events.
 * Runs trigger evaluation on every price update.
 */
export async function startTriggerEngine(): Promise<void> {
    if (handler) return; // already started

    // ── Startup recovery: mark orphaned TRIGGERED triggers as FAILED ──
    await recoverOrphanedTriggers();

    handler = (event) => {
        if (event.type === "replay.tick") {
            const { pairId, last } = event.data;
            evaluateTriggersForPair(pairId, { last }).catch((err) => {
                logger.error({ pairId, err }, "trigger_eval_replay_error");
            });
        } else if (event.type === "price.tick") {
            const { pairId, last } = event.data;
            evaluateTriggersForPair(pairId, { last }).catch((err) => {
                logger.error({ pairId, err }, "trigger_eval_live_error");
            });
        }
    };

    subscribeGlobal(handler);
    logger.info("Trigger engine started");
}

/**
 * Startup recovery: find triggers stuck in TRIGGERED state with no derived
 * order (server crashed between Phase 1 and Phase 2 of fireTrigger).
 * Mark them as FAILED for manual review.
 */
async function recoverOrphanedTriggers(): Promise<void> {
    const client = await pool.connect();
    try {
        const { rows } = await client.query<{ id: string }>(
            `SELECT id FROM trigger_orders
             WHERE status = 'TRIGGERED' AND derived_order_id IS NULL`,
        );

        if (rows.length === 0) return;

        logger.warn({ count: rows.length }, "trigger_orphan_recovery_start");

        await client.query("BEGIN");
        for (const row of rows) {
            await setStatusTx(client, row.id, "FAILED", {
                failReason: "server_restart_recovery",
            });
            logger.warn({ triggerId: row.id }, "trigger_orphan_marked_failed");
        }
        await client.query("COMMIT");

        logger.info({ count: rows.length }, "trigger_orphan_recovery_complete");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        logger.error({ err }, "trigger_orphan_recovery_error");
    } finally {
        client.release();
    }
}

/**
 * Teardown: unsubscribe from event bus.
 */
export function stopTriggerEngine(): void {
    if (handler) {
        unsubscribe(handler);
        handler = null;
        logger.info("Trigger engine stopped");
    }
}
