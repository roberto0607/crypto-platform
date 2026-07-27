import { pool } from "../db/pool.js";

export interface MessageRow {
    id: string;
    conversation_id: string;
    sender_id: string;
    body: string | null;
    image_url: string | null;
    created_at: string;
    read_at: string | null;
}

const COLUMNS = `id, conversation_id, sender_id, body, image_url, created_at, read_at`;

export async function insertMessage(
    conversationId: string,
    senderId: string,
    body: string,
): Promise<MessageRow> {
    const { rows } = await pool.query<MessageRow>(
        `INSERT INTO messages (conversation_id, sender_id, body)
         VALUES ($1, $2, $3)
         RETURNING ${COLUMNS}`,
        [conversationId, senderId, body],
    );
    return rows[0];
}

/** Keyset pagination on (created_at, id) DESC — same shape as ledger_entries. */
export async function listMessagesPaginated(
    conversationId: string,
    limit: number,
    cursor: { ca: string; id: string } | null,
): Promise<MessageRow[]> {
    let query = `SELECT ${COLUMNS} FROM messages WHERE conversation_id = $1`;
    const params: (string | number)[] = [conversationId];

    if (cursor) {
        params.push(cursor.ca);
        const caIdx = params.length;
        params.push(cursor.id);
        const idIdx = params.length;
        query += ` AND (created_at, id) < ($${caIdx}, $${idIdx})`;
    }

    params.push(limit + 1);
    query += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;

    const result = await pool.query<MessageRow>(query, params);
    return result.rows;
}
