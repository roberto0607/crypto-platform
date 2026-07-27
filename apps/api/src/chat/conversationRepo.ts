import { pool } from "../db/pool.js";

export interface ConversationRow {
    id: string;
    type: "dm" | "match";
    context_id: string | null;
    created_at: string;
}

export interface ConversationListRow extends ConversationRow {
    other_user_id: string | null;
    other_display_name: string | null;
}

const COLUMNS = `id, type, context_id, created_at`;

export async function getConversationById(id: string): Promise<ConversationRow | null> {
    const { rows } = await pool.query<ConversationRow>(
        `SELECT ${COLUMNS} FROM conversations WHERE id = $1`,
        [id],
    );
    return rows[0] ?? null;
}

export async function findDmConversationBetween(
    userA: string,
    userB: string,
): Promise<ConversationRow | null> {
    const { rows } = await pool.query<ConversationRow>(
        `SELECT c.id, c.type, c.context_id, c.created_at
         FROM conversations c
         JOIN conversation_participants p1 ON p1.conversation_id = c.id AND p1.user_id = $1
         JOIN conversation_participants p2 ON p2.conversation_id = c.id AND p2.user_id = $2
         WHERE c.type = 'dm'
         LIMIT 1`,
        [userA, userB],
    );
    return rows[0] ?? null;
}

export async function createDmConversation(
    userA: string,
    userB: string,
): Promise<ConversationRow> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const { rows } = await client.query<ConversationRow>(
            `INSERT INTO conversations (type) VALUES ('dm') RETURNING ${COLUMNS}`,
        );
        const conversation = rows[0];
        await client.query(
            `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
            [conversation.id, userA, userB],
        );
        await client.query("COMMIT");
        return conversation;
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

export async function isParticipant(conversationId: string, userId: string): Promise<boolean> {
    const { rows } = await pool.query(
        `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
        [conversationId, userId],
    );
    return rows.length > 0;
}

/** All OTHER participants' user ids (excludes `userId`). */
export async function getOtherParticipants(
    conversationId: string,
    userId: string,
): Promise<string[]> {
    const { rows } = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id <> $2`,
        [conversationId, userId],
    );
    return rows.map((r) => r.user_id);
}

/** DM conversations for `userId`, with the other participant's id + display name. */
export async function listDmConversationsForUser(userId: string): Promise<ConversationListRow[]> {
    const { rows } = await pool.query<ConversationListRow>(
        `SELECT c.id, c.type, c.context_id, c.created_at,
                op.user_id AS other_user_id, u.display_name AS other_display_name
         FROM conversations c
         JOIN conversation_participants me ON me.conversation_id = c.id AND me.user_id = $1
         LEFT JOIN conversation_participants op ON op.conversation_id = c.id AND op.user_id <> $1
         LEFT JOIN users u ON u.id = op.user_id
         WHERE c.type = 'dm'
         ORDER BY c.created_at DESC`,
        [userId],
    );
    return rows;
}
