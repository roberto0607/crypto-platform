import { pool } from "../db/pool";
import { listActiveTriggersForPair, markTriggeredTx, cancelOcoSiblingTx, setStatusTx } from "./triggerRepo";
import type { TriggerOrderRow } from "./triggerTypes";
import { placeOrderWithSnapshot } from "../trading/phase6OrderService";
import { subscribeGlobal, unsubscribe, publish } from "../events/eventBus";
import type { EventHandler } from "../events/eventBus";
import { createEvent } from "../events/eventTypes";
import { logger } from "../observability/logContext";

type PriceSnapshot = { last: string };

let handler: EventHandler | null = null;

/**
 * Pure crossing check — deterministic given (trigger, snapshot).
 *
 * STOP BUY  / TP SELL  → fire when last >= trigger_price
 * STOP SELL / TP BUY   → fire when last <= trigger_price
 */
export function shouldTrigger(
    trigger: TriggerOrderRow,
    snapshot: PriceSnapshot
): boolean {
    const last = parseFloat(snapshot.last);
    const tp = parseFloat(trigger.trigger_price);

    const isStop = trigger.kind.startsWith("STOP");
    const isBuy = trigger.side === "BUY";

    // STOP BUY or TAKE_PROFIT SELL → fire when last >= trigger_price
    // STOP SELL or TAKE_PROFIT BUY → fire when last <= trigger_price
    if ((isStop && isBuy) || (!isStop && !isBuy)) {
        return last >= tp;
    }
    return last <= tp;
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

    try {
        const result = await placeOrderWithSnapshot(trigger.user_id, {
            pairId: trigger.pair_id,
            side: trigger.side,
            type: derivedType,
            qty: trigger.qty,
            limitPrice: derivedLimitPrice,
        });

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
        if (shouldTrigger(trigger, snapshot)) {
            await fireTrigger(trigger, snapshot);
        }
    }
}

/**
 * Bootstrap: subscribe to event bus for replay.tick and price.tick events.
 * Runs trigger evaluation on every price update.
 */
export function startTriggerEngine(): void {
    if (handler) return; // already started

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
 * Teardown: unsubscribe from event bus.
 */
export function stopTriggerEngine(): void {
    if (handler) {
        unsubscribe(handler);
        handler = null;
        logger.info("Trigger engine stopped");
    }
}
