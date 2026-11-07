/**
 * Seasons: one global competition at a time, ranked on 1v1 results. Playing a
 * match in the window is what enters you, so a season has no participants and
 * no wallets. It only reads matches and elo_history; match logic is untouched.
 *
 * Lifecycle: `pnpm season:create` adds an UPCOMING row, competitionLifecycleJob
 * starts it, competitionLeaderboardJob refreshes the board, and past end_at the
 * lifecycle job calls finalizeSeason.
 */
import type { PoolClient } from "pg";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { notifyCompetitionEnded } from "../notifications/notificationService.js";
import { logger } from "../observability/logContext.js";
import { awardBadge } from "./badgeRepo.js";
import { lockCompetitionForUpdate, updateCompetitionStatus } from "./competitionRepo.js";
import type { CompetitionRow } from "./competitionTypes.js";

const DAY_MS = 86_400_000;
const OFF_SEASON_DAYS = 3;
const MAX_SEASON_DAYS = 365;
/** Stops two friends trading wins to climb. Only SCORE is capped. */
const SCORED_MATCHES_PER_OPPONENT = 3;
const MATCHES_TO_QUALIFY = 3;
const BADGE_PLACES = 10;
/** Tolerates the time between typing the command and running it. */
const PAST_START_GRACE_MS = 60_000;

export interface DisplaySeason {
    id: string;
    name: string;
    season_number: number;
    status: "ACTIVE" | "ENDED";
    start_at: string;
    end_at: string;
}

/**
 * What the Arena shows: the active season, else the last one during its
 * off-season (final standings), else nothing.
 */
export async function getDisplaySeason(): Promise<DisplaySeason | null> {
    const { rows } = await pool.query<DisplaySeason>(
        `SELECT id, name, season_number, status, start_at, end_at
         FROM competitions
         WHERE competition_type = 'SEASON'
           AND (status = 'ACTIVE' OR (status = 'ENDED' AND off_season_ends > now()))
         ORDER BY (status = 'ACTIVE') DESC, end_at DESC
         LIMIT 1`,
    );
    return rows[0] ?? null;
}

/**
 * Replace the board with the standings for matches finished in the window.
 * Each match gives both players a row. SCORE sums ELO change over a player's
 * first matches against each opponent; everything else uses all their matches.
 * Equity doesn't apply to a season, so it's written as 0.
 */
async function rebuildBoard(client: PoolClient, season: CompetitionRow): Promise<void> {
    await client.query(`DELETE FROM competition_leaderboard WHERE competition_id = $1`, [season.id]);
    if (config.eloIntegrityEnabled) {
        await rebuildBoardFromRatings(client, season);
        return;
    }
    await client.query(
        `WITH played AS (
             SELECT m.id AS match_id, m.completed_at, m.winner_id, side.user_id, side.rival_id, side.pnl_pct
               FROM matches m
              CROSS JOIN LATERAL (VALUES
                  (m.challenger_id, m.opponent_id, m.challenger_pnl_pct),
                  (m.opponent_id, m.challenger_id, m.opponent_pnl_pct)
              ) AS side(user_id, rival_id, pnl_pct)
              WHERE m.status IN ('COMPLETED', 'FORFEITED')
                AND m.completed_at >= $2 AND m.completed_at < $3
         ), numbered AS (
             SELECT played.*,
                    COALESCE(elo.change, 0) AS elo_change,
                    row_number() OVER (
                        PARTITION BY played.user_id, played.rival_id
                        ORDER BY played.completed_at, played.match_id
                    ) <= $4 AS scored
               FROM played
               LEFT JOIN (
                   SELECT match_id, user_id, sum(new_elo - old_elo) AS change
                     FROM elo_history
                    WHERE match_id IS NOT NULL
                    GROUP BY match_id, user_id
               ) elo ON elo.match_id = played.match_id AND elo.user_id = played.user_id
         ), standings AS (
             SELECT user_id,
                    count(*) AS matches,
                    100.0 * count(*) FILTER (WHERE winner_id = user_id) / count(*) AS win_rate,
                    avg(COALESCE(pnl_pct, 0)) AS avg_pnl,
                    sum(elo_change) FILTER (WHERE scored) AS score,
                    max(completed_at) FILTER (WHERE scored) AS reached_score_at
               FROM numbered
              GROUP BY user_id
         )
         INSERT INTO competition_leaderboard
             (competition_id, user_id, rank, equity, return_pct, trades_count, win_rate, nuanced_score)
         SELECT $1, user_id,
                row_number() OVER (ORDER BY score DESC, win_rate DESC, reached_score_at, user_id),
                0, avg_pnl, matches, win_rate, score
           FROM standings`,
        [season.id, season.start_at, season.end_at, SCORED_MATCHES_PER_OPPONENT],
    );
}

/**
 * ELO_INTEGRITY_ENABLED: the board is the season points stored per player per
 * match when it was resolved (eloIntegrity.ts), so nothing is recomputed. A
 * player's unrated wins don't count as matches; matches resolved without the
 * flag have no stored points and don't count at all.
 */
async function rebuildBoardFromRatings(client: PoolClient, season: CompetitionRow): Promise<void> {
    await client.query(
        `WITH standings AS (
             SELECT r.user_id,
                    count(*) AS matches,
                    100.0 * count(*) FILTER (WHERE r.result = 'WIN') / count(*) AS win_rate,
                    avg(COALESCE(CASE WHEN r.user_id = m.challenger_id THEN m.challenger_pnl_pct
                                      ELSE m.opponent_pnl_pct END, 0)) AS avg_pnl,
                    sum(r.season_points) AS score,
                    COALESCE(max(r.completed_at) FILTER (WHERE r.season_points <> 0), min(r.completed_at)) AS reached_score_at
               FROM match_ratings r
               JOIN matches m ON m.id = r.match_id
              WHERE r.season_id = $1 AND r.rated
                AND r.completed_at >= $2 AND r.completed_at < $3
              GROUP BY r.user_id
         )
         INSERT INTO competition_leaderboard
             (competition_id, user_id, rank, equity, return_pct, trades_count, win_rate, nuanced_score)
         SELECT $1, user_id,
                row_number() OVER (ORDER BY score DESC, win_rate DESC, reached_score_at, user_id),
                0, avg_pnl, matches, win_rate, score
           FROM standings`,
        [season.id, season.start_at, season.end_at],
    );
}

/** No-op unless the season is ACTIVE, so a final board is never rewritten. */
export async function refreshSeasonLeaderboard(seasonId: string): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const season = await lockCompetitionForUpdate(client, seasonId);
        if (season?.status === "ACTIVE") await rebuildBoard(client, season);
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function awardSeasonBadges(
    client: PoolClient,
    season: CompetitionRow,
    board: { user_id: string; rank: number; trades_count: number }[],
): Promise<void> {
    const qualified = board.filter((row) => row.trades_count >= MATCHES_TO_QUALIFY).slice(0, BADGE_PLACES);
    for (const [place, row] of qualified.entries()) {
        await awardBadge({
            userId: row.user_id,
            badgeType: place === 0 ? "SEASON_CHAMPION" : "SEASON_TOP_10",
            tier: "SEASON",
            weekId: `S${season.season_number}`,
            competitionId: season.id,
            metadata: { seasonName: season.name, rank: row.rank },
        }, client);
    }
}

/**
 * End an ACTIVE season: final board, status, badges, in one transaction.
 * Returns false if it was already ended, so running twice changes nothing.
 * ELO, tiers and records carry over.
 */
export async function finalizeSeason(seasonId: string): Promise<boolean> {
    const client = await pool.connect();
    let season: CompetitionRow | null;
    let board: { user_id: string; rank: number; trades_count: number }[];
    try {
        await client.query("BEGIN");
        season = await lockCompetitionForUpdate(client, seasonId);
        if (season?.competition_type !== "SEASON" || season.status !== "ACTIVE") {
            await client.query("ROLLBACK");
            return false;
        }
        await rebuildBoard(client, season);
        await updateCompetitionStatus(client, season.id, "ENDED");
        await client.query(
            `UPDATE competitions
             SET off_season_ends = COALESCE(off_season_ends, end_at + make_interval(days => $2))
             WHERE id = $1`,
            [season.id, OFF_SEASON_DAYS],
        );
        ({ rows: board } = await client.query(
            `SELECT user_id, rank, trades_count FROM competition_leaderboard
             WHERE competition_id = $1 ORDER BY rank`,
            [season.id],
        ));
        await awardSeasonBadges(client, season, board);
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }

    logger.info({ seasonId, players: board.length }, "season_finalized");
    for (const row of board) {
        await notifyCompetitionEnded(row.user_id, season.name, season.id, row.rank);
    }
    return true;
}

export interface CreateSeasonPlan {
    applied: boolean;
    seasonNumber: number;
    name: string;
    startAt: Date;
    endAt: Date;
    offSeasonEndsAt: Date;
}

/** Checks everything either way; writes only with apply. Throws if it can't be done. */
export async function createSeason(
    input: { name: string; days: number; start?: Date },
    { apply }: { apply: boolean },
): Promise<CreateSeasonPlan> {
    const name = input.name.trim();
    if (!name) throw new Error("A season needs a name.");
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_SEASON_DAYS) {
        throw new Error(`days must be a whole number from 1 to ${MAX_SEASON_DAYS}.`);
    }
    const startAt = input.start ?? new Date();
    if (startAt.getTime() < Date.now() - PAST_START_GRACE_MS) {
        throw new Error("The start time is in the past.");
    }

    const { rows } = await pool.query<{ open: string | null; latest: number | null }>(
        `SELECT max(name) FILTER (WHERE status IN ('UPCOMING', 'ACTIVE')) AS open,
                max(season_number) AS latest
         FROM competitions WHERE competition_type = 'SEASON'`,
    );
    if (rows[0]!.open) throw new Error(`A season is already open: ${rows[0]!.open}.`);

    const plan: CreateSeasonPlan = {
        applied: false,
        seasonNumber: (rows[0]!.latest ?? 0) + 1,
        name,
        startAt,
        endAt: new Date(startAt.getTime() + input.days * DAY_MS),
        offSeasonEndsAt: new Date(startAt.getTime() + (input.days + OFF_SEASON_DAYS) * DAY_MS),
    };
    if (!apply) return plan;

    await pool.query(
        `INSERT INTO competitions (name, start_at, end_at, status, competition_type, season_number, off_season_ends)
         VALUES ($1, $2, $3, 'UPCOMING', 'SEASON', $4, $5)`,
        [plan.name, plan.startAt, plan.endAt, plan.seasonNumber, plan.offSeasonEndsAt],
    );
    return { ...plan, applied: true };
}

export interface CloseSeasonPlan {
    applied: boolean;
    action: "close" | "cancel";
    name: string;
    status: string;
}

/**
 * Close moves end_at to now and leaves the ending to the lifecycle job, so
 * there's one path to a final board. Cancel ends it with no ranks or badges.
 */
export async function closeSeason(
    seasonId: string,
    { apply, cancel }: { apply: boolean; cancel: boolean },
): Promise<CloseSeasonPlan> {
    const { rows } = await pool.query<{ name: string; status: string }>(
        `SELECT name, status FROM competitions WHERE id = $1 AND competition_type = 'SEASON'`,
        [seasonId],
    );
    const season = rows[0];
    if (!season) throw new Error("Season not found.");
    if (season.status === "ENDED" || season.status === "CANCELLED") {
        throw new Error(`${season.name} is already ${season.status.toLowerCase()}.`);
    }
    if (!cancel && season.status !== "ACTIVE") {
        throw new Error(`${season.name} is not active yet. Use --cancel to drop it.`);
    }

    const plan: CloseSeasonPlan = { applied: false, action: cancel ? "cancel" : "close", ...season };
    if (!apply) return plan;

    await pool.query(
        cancel
            ? `UPDATE competitions SET status = 'CANCELLED', updated_at = now() WHERE id = $1`
            : `UPDATE competitions
               SET end_at = now(), off_season_ends = now() + make_interval(days => ${OFF_SEASON_DAYS}), updated_at = now()
               WHERE id = $1`,
        [seasonId],
    );
    return { ...plan, applied: true };
}
