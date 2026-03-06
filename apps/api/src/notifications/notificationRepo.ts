import { pool } from "../db/pool.js";

export interface NotificationRow {
    id: string;
    user_id: string;
    kind: string;
    title: string;
    body: string | null;
    metadata: Record<string, unknown>;
    read_at: string | null;
    created_at: string;
}

const COLUMNS = `id, user_id, kind, title, body, metadata, read_at, created_at`;

export async function createNotification(params: {
    userId: string;
    kind: string;
    title: string;
    body?: string;
    metadata?: Record<string, unknown>;
}): Promise<NotificationRow> {
    const { rows } = await pool.query<NotificationRow>(
        `INSERT INTO notifications (user_id, kind, title, body, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING ${COLUMNS}`,
        [
            params.userId,
            params.kind,
            params.title,
            params.body ?? null,
            JSON.stringify(params.metadata ?? {}),
        ],
    );

    // Auto-prune: keep only the latest 100 notifications per user
    await pool.query(
        `DELETE FROM notifications
         WHERE user_id = $1
           AND id NOT IN (
               SELECT id FROM notifications
               WHERE user_id = $1
               ORDER BY created_at DESC
               LIMIT 100
           )`,
        [params.userId],
    ).catch(() => {}); // Non-fatal

    return rows[0];
}

export async function listNotifications(
    userId: string,
    limit = 50,
): Promise<NotificationRow[]> {
    const { rows } = await pool.query<NotificationRow>(
        `SELECT ${COLUMNS} FROM notifications
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [userId, limit],
    );
    return rows;
}

export async function getUnreadCount(userId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM notifications
         WHERE user_id = $1 AND read_at IS NULL`,
        [userId],
    );
    return parseInt(rows[0].count);
}

export async function markAsRead(
    userId: string,
    notificationId: string,
): Promise<void> {
    await pool.query(
        `UPDATE notifications SET read_at = now()
         WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
        [notificationId, userId],
    );
}

export async function markAllAsRead(userId: string): Promise<number> {
    const result = await pool.query(
        `UPDATE notifications SET read_at = now()
         WHERE user_id = $1 AND read_at IS NULL`,
        [userId],
    );
    return result.rowCount ?? 0;
}
