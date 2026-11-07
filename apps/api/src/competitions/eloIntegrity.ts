/**
 * ELO integrity rules (ELO_INTEGRITY_ENABLED). They stop two players farming
 * ELO and season score off each other while keeping lower tiers forgiving.
 *
 * Per match, the winner's gain is blocked (the winner is unrated: no ELO, win,
 * streak, badge or promotion progress) when any of these holds:
 *   - EARLY_FORFEIT: forfeited in the first 25% of the match, at most 15 min.
 *   - NOT_QUALIFIED: either player made no fill of their own, or traded less
 *     than 10% of starting capital (fills before match-end settlement).
 *   - REPEAT_OPPONENT: the pair's third+ match within 24h.
 * The loser always takes their tier loss, scaled by the 24h rule (100/50/0%).
 * Rated wins get the upset bonus only if the loser is 50+ ELO higher.
 *
 * Season points (season board) per player per match: the ELO change with the
 * win streak counted from the season start, times 100/50/25% for the 1st–3rd,
 * 4th–6th and 7th+ match against that opponent in the season.
 */
import type { PoolClient } from "pg";

/** A player's own fills in a match, read before match-end settlement. */
export interface MatchActivity {
    fills: number;
    notional: number;
}

export type UnratedReason = "EARLY_FORFEIT" | "NOT_QUALIFIED" | "REPEAT_OPPONENT";

export const UPSET_MIN_GAP = 50;
export const MIN_NOTIONAL_FRACTION = 0.1;
const PAIR_SCALES = [1, 0.5];
const EARLY_FORFEIT_FRACTION = 0.25;
const EARLY_FORFEIT_MAX_MS = 15 * 60_000;

export function qualifies(activity: MatchActivity | undefined, startingCapital: number): boolean {
    return !!activity && activity.fills >= 1 && activity.notional >= startingCapital * MIN_NOTIONAL_FRACTION;
}

/** Scale for the pair's next match, given how many they finished in the last 24h. */
export function pairScale(priorMatches: number): number {
    return PAIR_SCALES[priorMatches] ?? 0;
}

export function isEarlyForfeit(match: {
    status: string;
    started_at: Date | null;
    completed_at: Date | null;
    duration_hours: number;
}): boolean {
    if (match.status !== "FORFEITED" || !match.started_at || !match.completed_at) return false;
    const window = Math.min(EARLY_FORFEIT_MAX_MS, match.duration_hours * 3_600_000 * EARLY_FORFEIT_FRACTION);
    return match.completed_at.getTime() - match.started_at.getTime() < window;
}

export function seasonOpponentWeight(ordinal: number): number {
    return ordinal <= 3 ? 1 : ordinal <= 6 ? 0.5 : 0.25;
}

/** Math.round without -0. */
export function roundDelta(x: number): number {
    return Math.round(x) || 0;
}

/**
 * Fills and traded notional per player. Call it before settleMatchAccountsTx:
 * the match-end force-closes are orders like any other (source NULL).
 */
export async function matchActivityTx(client: PoolClient, matchId: string): Promise<Map<string, MatchActivity>> {
    const { rows } = await client.query<{ user_id: string; fills: number; notional: string }>(
        `SELECT o.user_id, count(t.id)::int AS fills, COALESCE(sum(t.quote_amount), 0)::text AS notional
           FROM orders o
           JOIN trades t ON t.buy_order_id = o.id OR t.sell_order_id = o.id
          WHERE o.match_id = $1
          GROUP BY o.user_id`,
        [matchId],
    );
    return new Map(rows.map((r) => [r.user_id, { fills: r.fills, notional: Number(r.notional) }]));
}

/** The pair's other finished matches in the 24h up to this one. */
export async function priorPairMatchesTx(
    client: PoolClient,
    matchId: string,
    a: string,
    b: string,
    completedAt: Date,
): Promise<number> {
    const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM matches
          WHERE id <> $1
            AND status IN ('COMPLETED', 'FORFEITED')
            AND ((challenger_id = $2 AND opponent_id = $3) OR (challenger_id = $3 AND opponent_id = $2))
            AND completed_at > $4::timestamptz - interval '24 hours'
            AND completed_at <= $4`,
        [matchId, a, b, completedAt],
    );
    return rows[0]!.n;
}

export interface RatingEntry {
    userId: string;
    opponentId: string;
    result: "WIN" | "LOSS" | "DRAW";
    reason: UnratedReason | null;
    pairScale: number;
    eloDelta: number;
    /** Season points before the opponent weight, given the season win streak. */
    seasonDelta: (seasonStreak: number) => number;
}

/**
 * Record each player's side of a match, with season points if a season's
 * window holds completed_at.
 */
export async function writeMatchRatingsTx(
    client: PoolClient,
    matchId: string,
    completedAt: Date,
    entries: RatingEntry[],
): Promise<void> {
    const { rows: seasons } = await client.query<{ id: string }>(
        `SELECT id FROM competitions
          WHERE competition_type = 'SEASON' AND status IN ('UPCOMING', 'ACTIVE')
            AND start_at <= $1 AND end_at > $1
          ORDER BY start_at DESC LIMIT 1`,
        [completedAt],
    );
    const seasonId = seasons[0]?.id ?? null;

    for (const e of entries) {
        let streak: number | null = null;
        let weight: number | null = null;
        let points: number | null = null;
        if (seasonId) {
            const { rows: [prior] } = await client.query<{ ordinal: number; streak: number }>(
                // Streak: rated wins since the player's last rated loss this season.
                `SELECT count(*) FILTER (WHERE opponent_id = $3)::int + 1 AS ordinal,
                        count(*) FILTER (WHERE rated AND result = 'WIN' AND completed_at > COALESCE(
                            (SELECT max(completed_at) FROM match_ratings
                              WHERE season_id = $1 AND user_id = $2 AND rated AND result = 'LOSS'),
                            '-infinity'))::int AS streak
                   FROM match_ratings WHERE season_id = $1 AND user_id = $2`,
                [seasonId, e.userId, e.opponentId],
            );
            const ratedWin = e.result === "WIN" && e.reason === null;
            streak = prior!.streak + (ratedWin ? 1 : 0);
            weight = seasonOpponentWeight(prior!.ordinal);
            points = e.reason === null ? e.seasonDelta(streak) * weight : 0;
        }
        await client.query(
            `INSERT INTO match_ratings
                (match_id, user_id, opponent_id, result, rated, unrated_reason, pair_scale, elo_delta,
                 season_id, season_streak, season_weight, season_points, completed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
                matchId, e.userId, e.opponentId, e.result, e.reason === null, e.reason, e.pairScale, e.eloDelta,
                seasonId, streak, weight, points, completedAt,
            ],
        );
    }
}
