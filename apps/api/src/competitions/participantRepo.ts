import { pool } from "../db/pool.js";
import type { PoolClient } from "pg";
import type { ParticipantRow } from "./competitionTypes.js";

const COLUMNS = `id, competition_id, user_id, joined_at, starting_equity,
    final_equity, final_return_pct, final_max_drawdown_pct, final_rank, status, qualified`;

export async function insertParticipant(
    client: PoolClient,
    competitionId: string,
    userId: string,
    startingEquity: string,
): Promise<ParticipantRow> {
    const { rows } = await client.query<ParticipantRow>(
        `INSERT INTO competition_participants (competition_id, user_id, starting_equity)
         VALUES ($1, $2, $3)
         RETURNING ${COLUMNS}`,
        [competitionId, userId, startingEquity],
    );
    return rows[0];
}

export async function findParticipant(
    competitionId: string,
    userId: string,
): Promise<ParticipantRow | null> {
    const { rows } = await pool.query<ParticipantRow>(
        `SELECT ${COLUMNS} FROM competition_participants
         WHERE competition_id = $1 AND user_id = $2`,
        [competitionId, userId],
    );
    return rows[0] ?? null;
}

export async function countParticipants(
    client: PoolClient,
    competitionId: string,
): Promise<number> {
    const { rows } = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM competition_participants
         WHERE competition_id = $1 AND status = 'ACTIVE'`,
        [competitionId],
    );
    return parseInt(rows[0].count);
}

export async function updateParticipantStatus(
    client: PoolClient,
    competitionId: string,
    userId: string,
    status: ParticipantRow["status"],
): Promise<void> {
    await client.query(
        `UPDATE competition_participants SET status = $1
         WHERE competition_id = $2 AND user_id = $3`,
        [status, competitionId, userId],
    );
}

export async function listActiveParticipants(
    competitionId: string,
): Promise<ParticipantRow[]> {
    const { rows } = await pool.query<ParticipantRow>(
        `SELECT ${COLUMNS} FROM competition_participants
         WHERE competition_id = $1 AND status = 'ACTIVE'`,
        [competitionId],
    );
    return rows;
}

export async function listUserCompetitions(
    userId: string,
): Promise<Array<ParticipantRow & { competition_name: string; competition_status: string; start_at: string; end_at: string }>> {
    const { rows } = await pool.query(
        `SELECT cp.*, c.name AS competition_name, c.status AS competition_status,
                c.start_at, c.end_at
         FROM competition_participants cp
         JOIN competitions c ON c.id = cp.competition_id
         WHERE cp.user_id = $1
         ORDER BY c.start_at DESC`,
        [userId],
    );
    return rows as any;
}

export async function writeFinalsForParticipant(
    client: PoolClient,
    competitionId: string,
    userId: string,
    finalEquity: string,
    finalReturnPct: string,
    finalMaxDrawdownPct: string,
    finalRank: number,
): Promise<void> {
    await client.query(
        `UPDATE competition_participants
         SET final_equity = $3, final_return_pct = $4,
             final_max_drawdown_pct = $5, final_rank = $6
         WHERE competition_id = $1 AND user_id = $2`,
        [competitionId, userId, finalEquity, finalReturnPct, finalMaxDrawdownPct, finalRank],
    );
}
