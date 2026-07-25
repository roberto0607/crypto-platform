import { pool } from "../db/pool";
import type { PoolClient } from "pg";
import type { AlertConditionType, AlertFrequency, AlertRow } from "./alertTypes";

const ALERT_COLUMNS = `id, user_id, pair_id, condition_type, target_value, frequency, frequency_minutes, last_fired_at, status, expiration, message_template, channels, created_at, updated_at`;

export async function createAlert(params: {
    userId: string;
    pairId: string;
    conditionType: AlertConditionType;
    targetValue: string;
    frequency: AlertFrequency;
    frequencyMinutes?: number;
    expiration?: string;
    messageTemplate?: string;
    channels?: string[];
}): Promise<AlertRow> {
    const result = await pool.query<AlertRow>(
        `
        INSERT INTO alerts (user_id, pair_id, condition_type, target_value, frequency, frequency_minutes, expiration, message_template, channels)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, '["email"]'::jsonb))
        RETURNING ${ALERT_COLUMNS}
        `,
        [
            params.userId,
            params.pairId,
            params.conditionType,
            params.targetValue,
            params.frequency,
            params.frequencyMinutes ?? null,
            params.expiration ?? null,
            params.messageTemplate ?? null,
            params.channels ? JSON.stringify(params.channels) : null,
        ]
    );

    return result.rows[0];
}

// Full-table bootstrap load for alertEngine's in-memory index — unlike
// listActiveTriggersForPair, there's no per-pair filter since the engine
// buckets every active alert by pair itself.
export async function listActiveAlerts(): Promise<AlertRow[]> {
    const result = await pool.query<AlertRow>(
        `
        SELECT ${ALERT_COLUMNS}
        FROM alerts
        WHERE status = 'ACTIVE'
        ORDER BY created_at ASC, id ASC
        `
    );

    return result.rows;
}

export async function countActiveAlertsForUser(userId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
        `SELECT count(*) FROM alerts WHERE user_id = $1 AND status = 'ACTIVE'`,
        [userId]
    );

    return parseInt(result.rows[0].count, 10);
}

export async function listAlertsByUser(
    userId: string,
    filters: { pairId?: string; status?: string },
    limit: number,
    cursor: { ca: string; id: string } | null
): Promise<AlertRow[]> {
    let query = `SELECT ${ALERT_COLUMNS} FROM alerts WHERE user_id = $1`;
    const params: (string | number)[] = [userId];

    if (filters.pairId) {
        params.push(filters.pairId);
        query += ` AND pair_id = $${params.length}`;
    }

    if (filters.status) {
        params.push(filters.status);
        query += ` AND status = $${params.length}`;
    }

    if (cursor) {
        params.push(cursor.ca);
        const caIdx = params.length;
        params.push(cursor.id);
        const idIdx = params.length;
        query += ` AND (created_at, id) < ($${caIdx}, $${idIdx})`;
    }

    params.push(limit + 1);
    query += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;

    const result = await pool.query<AlertRow>(query, params);
    return result.rows;
}

// ONCE alerts: two-phase SELECT FOR UPDATE + confirm ACTIVE + UPDATE, same
// shape as triggerRepo.ts's markTriggeredTx, so a race between two ticks
// landing close together can't double-fire.
export async function markFiredTx(
    client: PoolClient,
    alertId: string
): Promise<AlertRow | null> {
    const lock = await client.query<AlertRow>(
        `
        SELECT ${ALERT_COLUMNS}
        FROM alerts
        WHERE id = $1
        FOR UPDATE
        `,
        [alertId]
    );

    const row = lock.rows[0];
    if (!row || row.status !== "ACTIVE") return null;

    const result = await client.query<AlertRow>(
        `
        UPDATE alerts
        SET status = 'FIRED'
        WHERE id = $1
        RETURNING ${ALERT_COLUMNS}
        `,
        [alertId]
    );

    return result.rows[0];
}

// EVERY_N_MINUTES alerts: the cadence check lives in the UPDATE's WHERE
// clause (not a separate SELECT-then-UPDATE) so two ticks that both read a
// stale last_fired_at can't both fire — only one wins the row.
export async function markFiredEveryNMinutes(alertId: string): Promise<AlertRow | null> {
    const result = await pool.query<AlertRow>(
        `
        UPDATE alerts
        SET last_fired_at = now()
        WHERE id = $1
          AND status = 'ACTIVE'
          AND (last_fired_at IS NULL OR now() - last_fired_at >= (frequency_minutes || ' minutes')::interval)
        RETURNING ${ALERT_COLUMNS}
        `,
        [alertId]
    );

    return result.rows[0] ?? null;
}

export async function cancelAlertByUser(
    userId: string,
    alertId: string
): Promise<AlertRow> {
    // Atomic cancel: ownership, existence, and active-state checks are all part of the UPDATE.
    const result = await pool.query<AlertRow>(
        `
        UPDATE alerts
        SET status = 'CANCELLED'
        WHERE id = $1 AND user_id = $2 AND status = 'ACTIVE'
        RETURNING ${ALERT_COLUMNS}
        `,
        [alertId, userId]
    );

    if (result.rows.length > 0) {
        return result.rows[0];
    }

    // No row updated: either the alert doesn't exist, doesn't belong to this user,
    // or is not ACTIVE. If it exists for this user and is already CANCELLED, return it
    // (idempotent). Otherwise surface alert_not_found.
    const existing = await pool.query<AlertRow>(
        `
        SELECT ${ALERT_COLUMNS}
        FROM alerts
        WHERE id = $1 AND user_id = $2
        LIMIT 1
        `,
        [alertId, userId]
    );

    const row = existing.rows[0];
    if (!row) throw new Error("alert_not_found");
    if (row.status === "CANCELLED") return row;
    throw new Error("alert_not_cancelable");
}

// Periodic sweep (called from alertEngine's resync timer) — flips expired
// ACTIVE alerts to EXPIRED in bulk so the per-tick evaluation path never
// needs to check wall-clock expiration itself. Returns the affected rows
// so the caller can evict them from the in-memory index and publish
// alert.updated per row.
export async function markExpiredSweep(): Promise<AlertRow[]> {
    const result = await pool.query<AlertRow>(
        `
        UPDATE alerts
        SET status = 'EXPIRED'
        WHERE status = 'ACTIVE' AND expiration IS NOT NULL AND expiration < now()
        RETURNING ${ALERT_COLUMNS}
        `
    );

    return result.rows;
}
