/**
 * Route-level rules around a 1v1 challenge: who may be challenged, how often,
 * and telling the other player a pending challenge ended. Kept out of
 * matchService so match creation, accept and settlement stay as they are.
 */
import { pool } from "../db/pool.js";
import { AppError } from "../errors/AppError.js";
import { publish } from "../events/eventBus.js";
import { createEvent } from "../events/eventTypes.js";
import { logger } from "../observability/logContext.js";
import { isSystemUser } from "../trading/buyingPower.js";
import type { MatchRow } from "./matchService.js";

const CHALLENGES_PER_HOUR = 10;

/**
 * Throws unless challengerId may challenge opponentId right now; returns the
 * challenger's username. The hourly count reads matches.created_at, so a
 * withdrawn or declined challenge still counts: create-then-cancel can't get
 * around it.
 */
export async function assertCanChallenge(challengerId: string, opponentId: string): Promise<string> {
    if (challengerId === opponentId) throw new AppError("self_challenge");

    const { rows } = await pool.query<{ id: string; display_name: string }>(
        `SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])`,
        [[challengerId, opponentId]],
    );
    if (!rows.some((row) => row.id === opponentId)) throw new AppError("player_not_found");
    if (await isSystemUser(opponentId)) throw new AppError("player_not_challengeable");

    const { rows: recent } = await pool.query<{ count: string }>(
        `SELECT count(*) FROM matches
         WHERE challenger_id = $1 AND created_at > now() - interval '1 hour'`,
        [challengerId],
    );
    if (Number(recent[0]!.count) >= CHALLENGES_PER_HOUR) throw new AppError("challenge_limit_reached");

    return rows.find((row) => row.id === challengerId)!.display_name;
}

/**
 * A pending challenge was cancelled: tell the other player, so a stale ACCEPT
 * button or "challenge sent" card doesn't linger. Best-effort, like every push
 * after a commit: the cancel has already succeeded.
 */
export async function publishChallengeClosed(match: MatchRow, byUserId: string): Promise<void> {
    try {
        const { rows } = await pool.query<{ display_name: string }>(
            `SELECT display_name FROM users WHERE id = $1`,
            [byUserId],
        );
        const declined = byUserId === match.opponent_id;
        publish(createEvent("challenge.closed", {
            matchId: match.id,
            reason: declined ? "declined" : "withdrawn",
            byName: rows[0]?.display_name ?? "Your opponent",
        }, { userId: declined ? match.challenger_id : match.opponent_id }));
    } catch (err) {
        logger.error({ err, matchId: match.id }, "challenge_closed_publish_failed");
    }
}
