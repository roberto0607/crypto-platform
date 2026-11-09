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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A competition's wallets trade only while it runs: past end_at, or once it
 * is ENDED or CANCELLED, an order is refused (competition_ended). Final ranks
 * are written when it ends, so a later order would only move wallets nobody
 * scores. An unknown id is left to the orders FK, as before.
 */
export async function assertCompetitionOpen(competitionId: string): Promise<void> {
    if (!UUID_RE.test(competitionId)) return;
    const { rows } = await pool.query<{ open: boolean }>(
        `SELECT status NOT IN ('ENDED', 'CANCELLED') AND end_at > now() AS open
           FROM competitions WHERE id = $1`,
        [competitionId],
    );
    if (rows[0] && !rows[0].open) throw new AppError("competition_ended");
}
