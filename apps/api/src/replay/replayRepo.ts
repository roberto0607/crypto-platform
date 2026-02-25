import { pool } from "../db/pool";

export type ReplaySessionRow = {
    user_id: string;
    pair_id: string;
    current_ts: string;
    speed: string;
    is_active: boolean;
    is_paused: boolean;
    timeframe: string;
    created_at: string;
    updated_at: string;
};

const SESSION_COLUMNS = `user_id, pair_id, current_ts, speed, is_active, is_paused, timeframe, created_at, updated_at`;

export async function createOrStartSession(
    userId: string,
    pairId: string,
    startTs: string,
    timeframe: string,
    speed: number
): Promise<ReplaySessionRow> {
    const result = await pool.query<ReplaySessionRow>(
        `
        INSERT INTO replay_sessions (user_id, pair_id, current_ts, timeframe, speed, is_active, is_paused)
        VALUES ($1, $2, $3, $4, $5, true, false)
        ON CONFLICT (user_id, pair_id) DO UPDATE
            SET current_ts = $3,
                timeframe = $4,
                speed = $5,
                is_active = true,
                is_paused = false
        RETURNING ${SESSION_COLUMNS}
        `,
        [userId, pairId, startTs, timeframe, speed]
    );

    return result.rows[0];
}

export async function getSession(userid: string, pairId: string): Promise<ReplaySessionRow | null> {
    const result = await pool.query<ReplaySessionRow>(
        `
        SELECT ${SESSION_COLUMNS}
        FROM replay_sessions
        WHERE user_id = $1 AND pair_id = $2 AND is_active = true
        LIMIT 1
        `,
        [userid, pairId]
    );

    return result.rows[0] ?? null;
}

export async function setPaused(userId: string, pairId: string, paused: boolean): Promise<ReplaySessionRow | null> {
    const result = await pool.query<ReplaySessionRow>(
        `
        UPDATE replay_sessions
        SET is_paused = $3
        WHERE user_id = $1 AND pair_id = $2 AND is_active = true
        RETURNING ${SESSION_COLUMNS}
        `,
        [userId, pairId, paused]
    );

    return result.rows[0] ?? null;
}

export async function seek(userId: string, pairid: string, ts: string): Promise<ReplaySessionRow | null> {
    const result = await pool.query<ReplaySessionRow>(
        `
        UPDATE replay_sessions
        SET current_ts = $3
        WHERE user_id = $1 AND pair_id = $2 AND is_active = true
        RETURNING ${SESSION_COLUMNS}
        `,
        [userId, pairid, ts]
    );

    return result.rows[0] ?? null;
}

export async function stopSession(userId: string, pairId: string): Promise<boolean> {
    const result = await pool.query(
        `
        DELETE FROM replay_sessions
        WHERE user_id = $1 AND pair_id = $2
        `,
        [userId, pairId]
    );

    return (result.rowCount ?? 0) > 0;
}
