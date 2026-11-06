import { pool } from "../db/pool";
import { AppError } from "../errors/AppError";
import { parseMatchScope } from "../http/matchScopeQuery";

/**
 * The match an order or trigger belongs to (null = free-play), from the scope
 * the request names. A user in a live match can trade it or practice on
 * free-play, so this is never inferred from "the user is in a match". A scope
 * that can't be honored is refused: rerouting it would put the order in a
 * wallet the player wasn't looking at.
 */
export async function resolveTradeScope(userId: string, raw: unknown): Promise<string | null> {
    if (raw === undefined) throw new AppError("scope_required");
    const scope = parseMatchScope(raw);
    if (scope === "invalid" || scope === undefined) throw new AppError("invalid_input");
    if (scope === null) return null;

    const { rows } = await pool.query<{ status: string; challenger_id: string; opponent_id: string }>(
        `SELECT status, challenger_id, opponent_id FROM matches WHERE id = $1`,
        [scope],
    );
    const match = rows[0];
    if (!match || (match.challenger_id !== userId && match.opponent_id !== userId)) {
        throw new AppError("forbidden");
    }
    if (match.status !== "ACTIVE") throw new AppError("match_ended");
    return scope;
}
