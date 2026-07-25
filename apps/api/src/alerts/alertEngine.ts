import { pool } from "../db/pool";
import {
    listActiveAlerts,
    getAlertById,
    markFiredTx,
    markFiredEveryNMinutes,
    markExpiredSweep,
} from "./alertRepo";
import type { AlertRow } from "./alertTypes";
import { subscribeGlobal, unsubscribe, publish } from "../events/eventBus";
import type { EventHandler } from "../events/eventBus";
import { createEvent, type AlertUpdatedData } from "../events/eventTypes";
import { findPairById } from "../trading/pairRepo";
import { logger } from "../observability/logContext";
import { sendEmail } from "../email/emailTransport";
import { alertFiredEmail } from "../email/templates";

// Periodic full resync — self-healing safety net mirroring krakenWs.ts's
// SYMBOL_REFRESH_INTERVAL_MS pattern. Covers an instance that missed an
// alert.updated event (e.g. it was mid-restart) and protects against any bug
// in the incremental-patch path silently drifting the index from the DB
// over time. Also where the expiration sweep runs.
const ALERT_INDEX_RESYNC_INTERVAL_MS = 5 * 60_000;

let handler: EventHandler | null = null;
let resyncTimer: ReturnType<typeof setInterval> | null = null;

// Deliberate departure from triggerEngine.ts, which queries
// listActiveTriggersForPair (a live pool.query) on every single tick.
// This in-memory index avoids the DB round-trip on the hot path and keeps
// the alert engine architecturally independent of DB latency spikes.
const alertsByPair = new Map<string, AlertRow[]>();
const lastPriceByPair = new Map<string, number>();

/**
 * Pure crossing check — deterministic given (alert, prevPrice, currentPrice),
 * directly unit-testable without a live tick. prevPrice === null (first
 * tick this process has seen for the pair, e.g. right after boot) means no
 * crossing can be detected yet — correctly skipped, not a false positive.
 */
export function shouldFireAlert(
    alert: AlertRow,
    prevPrice: number | null,
    currentPrice: number
): boolean {
    const target = parseFloat(alert.target_value);
    switch (alert.condition_type) {
        case "CROSSING":
            return prevPrice !== null && (
                (prevPrice < target && currentPrice >= target) ||
                (prevPrice > target && currentPrice <= target)
            );
        case "CROSSING_UP":
            return prevPrice !== null && prevPrice < target && currentPrice >= target;
        case "CROSSING_DOWN":
            return prevPrice !== null && prevPrice > target && currentPrice <= target;
    }
}

// ── In-memory index maintenance ──

function indexAlert(alert: AlertRow): void {
    const list = alertsByPair.get(alert.pair_id);
    if (list) {
        list.push(alert);
    } else {
        alertsByPair.set(alert.pair_id, [alert]);
    }
}

function unindexAlert(alertId: string, pairId: string): void {
    const list = alertsByPair.get(pairId);
    if (!list) return;
    const next = list.filter((a) => a.id !== alertId);
    if (next.length > 0) {
        alertsByPair.set(pairId, next);
    } else {
        alertsByPair.delete(pairId);
    }
}

async function loadIndex(): Promise<void> {
    const alerts = await listActiveAlerts();
    alertsByPair.clear();
    for (const alert of alerts) {
        indexAlert(alert);
    }
}

function publishAlertUpdated(alertId: string, pairId: string, action: AlertUpdatedData["action"]): void {
    try {
        publish(createEvent("alert.updated", { alertId, pairId, action }));
    } catch {
        // Events must never break the alert engine
    }
}

// ── Email delivery ──

async function getUserEmailInfo(userId: string): Promise<{ email: string; verified: boolean } | null> {
    const { rows } = await pool.query<{ email: string; email_verified_at: string | null }>(
        "SELECT email, email_verified_at FROM users WHERE id = $1",
        [userId]
    );
    const row = rows[0];
    if (!row) return null;
    return { email: row.email, verified: !!row.email_verified_at };
}

async function sendAlertEmailTo(email: string, alert: AlertRow, currentPrice: number): Promise<void> {
    const pair = await findPairById(alert.pair_id);
    const symbol = pair?.symbol ?? alert.pair_id;

    const { subject, html } = alertFiredEmail(
        symbol,
        alert.condition_type,
        alert.target_value,
        currentPrice.toFixed(8),
        alert.message_template
    );

    await sendEmail(email, subject, html);
}

// ── Firing logic ──

async function fireOnceAlert(alert: AlertRow, currentPrice: number): Promise<void> {
    // Verification gate runs BEFORE the status flip: an unverified user's
    // ONCE alert must stay ACTIVE and retry on the next matching tick, not
    // silently burn its one shot with no email ever received.
    const userInfo = await getUserEmailInfo(alert.user_id);
    if (!userInfo?.verified) {
        logger.warn({ userId: alert.user_id, alertId: alert.id }, "alert_fire_skipped_unverified_email");
        return;
    }

    const client = await pool.connect();
    let fired: AlertRow | null = null;
    try {
        await client.query("BEGIN");
        fired = await markFiredTx(client, alert.id);
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK");
        logger.error({ alertId: alert.id, err }, "alert_fire_txn_error");
        return;
    } finally {
        client.release();
    }

    if (!fired) return; // already fired/canceled by another tick — idempotent

    unindexAlert(fired.id, fired.pair_id);
    publishAlertUpdated(fired.id, fired.pair_id, "fired");

    await sendAlertEmailTo(userInfo.email, fired, currentPrice).catch((err) => {
        logger.error({ alertId: alert.id, err }, "alert_email_send_failed");
    });
}

async function fireRecurringAlert(alert: AlertRow, currentPrice: number): Promise<void> {
    // Cadence claim first — the race-safe WHERE clause in markFiredEveryNMinutes
    // ensures only one tick wins a given firing window. Unlike ONCE, a
    // recurring alert has no terminal "shot" to protect, so (per Gate 1 open
    // question 3's scope — ONCE only) the cadence still advances even if the
    // user is unverified; only the email send is gated below.
    const claimed = await markFiredEveryNMinutes(alert.id);
    if (!claimed) return; // another tick already claimed this firing window

    const userInfo = await getUserEmailInfo(alert.user_id);
    if (!userInfo?.verified) {
        logger.warn({ userId: alert.user_id, alertId: alert.id }, "alert_fire_skipped_unverified_email");
        return;
    }

    await sendAlertEmailTo(userInfo.email, claimed, currentPrice).catch((err) => {
        logger.error({ alertId: alert.id, err }, "alert_email_send_failed");
    });
}

/**
 * Evaluate all ACTIVE alerts indexed for a pair against the current price.
 * Fires each alert that crosses its threshold, then records the current
 * price as "previous" for the next tick's crossing check.
 */
export async function evaluateAlertsForPair(pairId: string, lastStr: string): Promise<void> {
    const currentPrice = parseFloat(lastStr);
    const prevPrice = lastPriceByPair.get(pairId) ?? null;
    const alerts = alertsByPair.get(pairId);

    if (alerts) {
        // Snapshot the array before iterating — firing an alert mutates
        // alertsByPair.get(pairId) in place (unindexAlert), which would
        // otherwise skip or double-visit entries mid-loop.
        for (const alert of [...alerts]) {
            if (!shouldFireAlert(alert, prevPrice, currentPrice)) continue;

            if (alert.frequency === "ONCE") {
                await fireOnceAlert(alert, currentPrice);
            } else {
                await fireRecurringAlert(alert, currentPrice);
            }
        }
    }

    lastPriceByPair.set(pairId, currentPrice);
}

async function applyAlertUpdatedPatch(data: AlertUpdatedData): Promise<void> {
    if (data.action === "created") {
        const alert = await getAlertById(data.alertId);
        if (alert && alert.status === "ACTIVE") {
            indexAlert(alert);
        }
        return;
    }

    // fired / cancelled / expired — no longer ACTIVE, remove from index
    unindexAlert(data.alertId, data.pairId);
}

async function resync(): Promise<void> {
    const expired = await markExpiredSweep();
    await loadIndex();
    for (const alert of expired) {
        publishAlertUpdated(alert.id, alert.pair_id, "expired");
    }
}

/**
 * Bootstrap: full-load the ACTIVE alert index, subscribe to the event bus
 * for price.tick/replay.tick (evaluation) and alert.updated (targeted index
 * patches — published by the CRUD routes alongside their DB writes, riding
 * the same Redis-mirrored eventBus that already keeps multi-instance state
 * in sync for price.tick/trigger.fired), and start the periodic resync
 * safety net.
 */
export async function startAlertEngine(): Promise<void> {
    if (handler) return; // already started

    await loadIndex();

    handler = (event) => {
        if (event.type === "replay.tick" || event.type === "price.tick") {
            const { pairId, last } = event.data;
            evaluateAlertsForPair(pairId, last).catch((err) => {
                logger.error({ pairId, err }, "alert_eval_error");
            });
        } else if (event.type === "alert.updated") {
            applyAlertUpdatedPatch(event.data).catch((err) => {
                logger.error({ err }, "alert_index_patch_error");
            });
        }
    };

    subscribeGlobal(handler);

    resyncTimer = setInterval(() => {
        resync().catch((err) => {
            logger.error({ err }, "alert_index_resync_error");
        });
    }, ALERT_INDEX_RESYNC_INTERVAL_MS);

    logger.info("Alert engine started");
}

/**
 * Teardown: unsubscribe from event bus, stop the resync timer.
 */
export function stopAlertEngine(): void {
    if (handler) {
        unsubscribe(handler);
        handler = null;
    }
    if (resyncTimer) {
        clearInterval(resyncTimer);
        resyncTimer = null;
    }
    logger.info("Alert engine stopped");
}
