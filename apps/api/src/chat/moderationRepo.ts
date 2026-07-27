import { pool } from "../db/pool.js";

export interface FlaggedMessageRow {
    id: string;
    message_id: string | null;
    body_snapshot: string | null;
    sender_id: string;
    reporter_id: string;
    conversation_type: "dm" | "match";
    reason: string | null;
    created_at: string;
}

const COLUMNS = `id, message_id, body_snapshot, sender_id, reporter_id, conversation_type, reason, created_at`;

export async function insertFlaggedMessage(params: {
    messageId: string;
    bodySnapshot: string | null;
    senderId: string;
    reporterId: string;
    conversationType: "dm" | "match";
    reason: string | null;
}): Promise<FlaggedMessageRow> {
    const { rows } = await pool.query<FlaggedMessageRow>(
        `INSERT INTO flagged_messages
            (message_id, body_snapshot, sender_id, reporter_id, conversation_type, reason)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${COLUMNS}`,
        [
            params.messageId,
            params.bodySnapshot,
            params.senderId,
            params.reporterId,
            params.conversationType,
            params.reason,
        ],
    );
    return rows[0];
}
