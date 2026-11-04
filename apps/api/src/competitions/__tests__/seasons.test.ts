import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { pool } from "../../db/pool";
import { ensureMigrations, resetTestData } from "../../testing/resetDb";
import { createTestUser } from "../../testing/fixtures";
import { joinCompetition } from "../competitionService";
import { competitionLifecycleJob } from "../../jobs/definitions/competitionLifecycleJob";
import { competitionLeaderboardJob } from "../../jobs/definitions/competitionLeaderboardJob";
import {
    closeSeason,
    createSeason,
    finalizeSeason,
    getDisplaySeason,
    refreshSeasonLeaderboard,
} from "../seasonService";

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);
const jobCtx = { pool, logger: { info: () => {}, error: () => {}, warn: () => {} } } as never;

async function player(name: string) {
    const user = await createTestUser(pool, { email: `${name}@realmail.test` });
    await pool.query(`UPDATE users SET display_name = $1 WHERE id = $2`, [name, user.id]);
    return user;
}

let seasonNumber = 0;
async function insertSeason(over: {
    status?: string; start?: Date; end?: Date; offSeasonEnds?: Date | null;
} = {}): Promise<{ id: string; start: Date; end: Date }> {
    const start = over.start ?? ago(48);
    const end = over.end ?? new Date(Date.now() + 48 * HOUR);
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO competitions (name, start_at, end_at, status, competition_type, season_number, off_season_ends)
         VALUES ($1, $2, $3, $4, 'SEASON', $5, $6) RETURNING id`,
        [`Season ${++seasonNumber}`, start, end, over.status ?? "ACTIVE", seasonNumber, over.offSeasonEnds ?? null],
    );
    return { id: rows[0]!.id, start, end };
}

/** A finished match, with the ELO rows the real engine leaves behind. */
async function played(
    winner: { id: string },
    loser: { id: string },
    over: { at?: Date; delta?: number; status?: string; winnerPnl?: string; loserPnl?: string; draw?: boolean } = {},
): Promise<void> {
    const delta = over.delta ?? 10;
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status,
                              winner_id, completed_at, challenger_pnl_pct, opponent_pnl_pct)
         VALUES ($1, $2, 24, 100000, $3, $4, $5, $6, $7) RETURNING id`,
        [
            winner.id, loser.id, over.status ?? "COMPLETED", over.draw ? null : winner.id,
            over.at ?? ago(1), over.winnerPnl ?? "2", over.loserPnl ?? "-2",
        ],
    );
    if (over.draw) return;
    await pool.query(
        `INSERT INTO elo_history (user_id, old_elo, new_elo, change_reason, match_id) VALUES
           ($1, 800, $3::int, 'MATCH_WIN', $5), ($2, 800, $4::int, 'MATCH_LOSS', $5)`,
        [winner.id, loser.id, 800 + delta, 800 - delta, rows[0]!.id],
    );
}

async function board(id: string) {
    const { rows } = await pool.query<{
        user_id: string; rank: number; nuanced_score: string; win_rate: string; return_pct: string; trades_count: number;
    }>(
        `SELECT user_id, rank, nuanced_score, win_rate, return_pct, trades_count
         FROM competition_leaderboard WHERE competition_id = $1 ORDER BY rank`,
        [id],
    );
    return rows;
}

const badges = async (userId: string) =>
    (await pool.query<{ badge_type: string; week_id: string }>(
        `SELECT badge_type, week_id FROM user_badges WHERE user_id = $1 ORDER BY badge_type`,
        [userId],
    )).rows;

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    await resetTestData();
    await pool.query(`DELETE FROM user_badges`);
    await pool.query(`DELETE FROM competitions`);
    seasonNumber = 0;
});

describe("schema", () => {
    it("allows only one open season", async () => {
        await insertSeason({ status: "ACTIVE" });
        await expect(insertSeason({ status: "UPCOMING" })).rejects.toMatchObject({ code: "23505" });
    });

    it("lets a new season open once the last one ended", async () => {
        await insertSeason({ status: "ENDED", end: ago(1) });
        await expect(insertSeason({ status: "ACTIVE" })).resolves.toBeDefined();
    });

    it("refuses a repeated season number, with tier NULL", async () => {
        await insertSeason({ status: "ENDED", end: ago(1) });
        seasonNumber = 0;
        await expect(insertSeason({ status: "ACTIVE" })).rejects.toMatchObject({ code: "23505" });
    });
});

describe("ranking", () => {
    it("scores ELO gained, with win rate, average P&L and matches played", async () => {
        const [a, b] = [await player("rank_a"), await player("rank_b")];
        const season = await insertSeason();
        await played(a, b, { delta: 20, winnerPnl: "4", loserPnl: "-4" });
        await played(b, a, { delta: 5, winnerPnl: "2", loserPnl: "-2" });

        await refreshSeasonLeaderboard(season.id);
        const [first, second] = await board(season.id);
        expect(first).toMatchObject({ user_id: a.id, rank: 1, trades_count: 2 });
        expect(Number(first!.nuanced_score)).toBe(15);
        expect(Number(first!.win_rate)).toBe(50);
        expect(Number(first!.return_pct)).toBe(1);
        expect(second).toMatchObject({ user_id: b.id, rank: 2 });
        expect(Number(second!.nuanced_score)).toBe(-15);
    });

    it("counts only the first 3 matches against the same opponent toward SCORE", async () => {
        const [a, b] = [await player("farm_a"), await player("farm_b")];
        const season = await insertSeason();
        for (let i = 0; i < 5; i++) await played(a, b, { delta: 10, at: ago(10 - i) });

        await refreshSeasonLeaderboard(season.id);
        const [first] = await board(season.id);
        expect(Number(first!.nuanced_score)).toBe(30);
        expect(first!.trades_count).toBe(5);
        expect(Number(first!.win_rate)).toBe(100);
    });

    it("applies the cap per opponent, in match order, whoever challenged", async () => {
        const [a, b, c] = [await player("cap_a"), await player("cap_b"), await player("cap_c")];
        const season = await insertSeason();
        await played(a, b, { delta: 1, at: ago(9) });
        await played(b, a, { delta: 2, at: ago(8) }); // a loses 2
        await played(a, b, { delta: 3, at: ago(7) });
        await played(a, b, { delta: 100, at: ago(6) }); // 4th vs b: ignored
        await played(a, c, { delta: 7, at: ago(5) }); // 1st vs c: counts

        await refreshSeasonLeaderboard(season.id);
        const row = (await board(season.id)).find((r) => r.user_id === a.id)!;
        expect(Number(row.nuanced_score)).toBe(1 - 2 + 3 + 7);
        expect(row.trades_count).toBe(5);
    });

    it("only counts finished matches inside the season window", async () => {
        const [a, b] = [await player("win_a"), await player("win_b")];
        const season = await insertSeason({ start: ago(10), end: new Date(Date.now() + HOUR) });
        await played(a, b, { delta: 100, at: ago(11) }); // before it started
        await played(a, b, { delta: 100, at: new Date(Date.now() + 2 * HOUR) }); // after it ends
        await played(a, b, { delta: 100, at: ago(1), status: "CANCELLED" });
        await played(a, b, { delta: 4, at: ago(2) });

        await refreshSeasonLeaderboard(season.id);
        const [first] = await board(season.id);
        expect(Number(first!.nuanced_score)).toBe(4);
        expect(first!.trades_count).toBe(1);
    });

    it("counts a forfeit and a draw as played; a draw scores nothing", async () => {
        const [a, b] = [await player("dr_a"), await player("dr_b")];
        const season = await insertSeason();
        await played(a, b, { delta: 6, status: "FORFEITED" });
        await played(a, b, { draw: true });

        await refreshSeasonLeaderboard(season.id);
        const [first] = await board(season.id);
        expect(Number(first!.nuanced_score)).toBe(6);
        expect(first!.trades_count).toBe(2);
        expect(Number(first!.win_rate)).toBe(50);
    });

    it("breaks a score tie on win rate", async () => {
        const [a, b, c, d] = [await player("t_a"), await player("t_b"), await player("t_c"), await player("t_d")];
        const season = await insertSeason();
        await played(a, c, { delta: 10 }); // a: +10, 1 of 1
        await played(b, c, { delta: 20 });
        await played(d, b, { delta: 10 }); // b: +10, 1 of 2
        await refreshSeasonLeaderboard(season.id);
        const ranks = await board(season.id);
        expect(ranks.findIndex((r) => r.user_id === a.id)).toBeLessThan(ranks.findIndex((r) => r.user_id === b.id));
    });

    it("breaks a tie on score and win rate by who got there first", async () => {
        const [a, b, c, d] = [await player("f_a"), await player("f_b"), await player("f_c"), await player("f_d")];
        const season = await insertSeason();
        await played(b, d, { delta: 10, at: ago(1) });
        await played(a, c, { delta: 10, at: ago(5) });
        await refreshSeasonLeaderboard(season.id);
        const [first, second] = await board(season.id);
        expect(first!.user_id).toBe(a.id);
        expect(second!.user_id).toBe(b.id);
    });

    it("rebuilds the board, so a refresh leaves no stale rows", async () => {
        const [a, b] = [await player("st_a"), await player("st_b")];
        const season = await insertSeason();
        await played(a, b);
        await refreshSeasonLeaderboard(season.id);
        await pool.query(`DELETE FROM elo_history`);
        await pool.query(`DELETE FROM matches`);
        await refreshSeasonLeaderboard(season.id);
        expect(await board(season.id)).toEqual([]);
    });

    it("the leaderboard job keeps a season fresh, without rank-change notifications", async () => {
        const [a, b] = [await player("job_a"), await player("job_b")];
        const season = await insertSeason();
        await played(a, b);
        await competitionLeaderboardJob.run(jobCtx);
        expect(await board(season.id)).toHaveLength(2);
        await played(b, a, { delta: 50 });
        await competitionLeaderboardJob.run(jobCtx);
        expect((await board(season.id))[0]!.user_id).toBe(b.id);
        const { rows } = await pool.query(`SELECT 1 FROM notifications WHERE kind = 'RANK_CHANGED'`);
        expect(rows).toHaveLength(0);
    });
});

describe("season end", () => {
    /** Each of `count` players beats a fresh sparring partner `matches` times. */
    async function field(count: number, matches = 3) {
        const players = [];
        for (let i = 0; i < count; i++) {
            const p = await player(`end_${i}`);
            for (let m = 0; m < matches; m++) {
                await played(p, await player(`spar_${i}_${m}`), { delta: 100 - i });
            }
            players.push(p);
        }
        return players;
    }

    it("freezes the board, records the off-season and awards badges", async () => {
        const [a, b] = await field(2);
        const season = await insertSeason({ end: new Date(Date.now() - 1000) });

        expect(await finalizeSeason(season.id)).toBe(true);

        const { rows } = await pool.query<{ status: string; off_season_ends: Date | null }>(
            `SELECT status, off_season_ends FROM competitions WHERE id = $1`, [season.id],
        );
        expect(rows[0]!.status).toBe("ENDED");
        expect(rows[0]!.off_season_ends!.getTime()).toBeGreaterThan(Date.now() + 2 * 24 * HOUR);
        expect(await badges(a!.id)).toEqual([{ badge_type: "SEASON_CHAMPION", week_id: "S1" }]);
        expect(await badges(b!.id)).toEqual([{ badge_type: "SEASON_TOP_10", week_id: "S1" }]);
    });

    it("ends only once: a second run changes nothing", async () => {
        const [a] = await field(1);
        const season = await insertSeason({ end: new Date(Date.now() - 1000) });
        expect(await finalizeSeason(season.id)).toBe(true);
        expect(await finalizeSeason(season.id)).toBe(false);
        expect(await badges(a!.id)).toHaveLength(1);
        const { rows } = await pool.query(`SELECT 1 FROM notifications WHERE kind = 'COMPETITION_ENDED' AND user_id = $1`, [a!.id]);
        expect(rows).toHaveLength(1);
    });

    it("gives rewards to qualifiers only: the top qualifier is champion, even below an unqualified #1", async () => {
        const [fast, slow, sparring] = [await player("two_games"), await player("three_games"), await player("sparring")];
        await played(fast, sparring, { delta: 90 });
        await played(fast, await player("sp2"), { delta: 90 });
        await played(slow, sparring, { delta: 10 });
        await played(slow, await player("sp3"), { delta: 10 });
        await played(slow, await player("sp4"), { delta: 10 });
        const season = await insertSeason({ end: new Date(Date.now() - 1000) });

        await finalizeSeason(season.id);

        expect((await board(season.id))[0]!.user_id).toBe(fast.id);
        expect(await badges(fast.id)).toEqual([]);
        expect(await badges(slow.id)).toEqual([{ badge_type: "SEASON_CHAMPION", week_id: "S1" }]);
    });

    it("stops at 10 badges", async () => {
        const players = await field(11, 3);
        const season = await insertSeason({ end: new Date(Date.now() - 1000) });
        await finalizeSeason(season.id);
        expect(await badges(players[9]!.id)).toEqual([{ badge_type: "SEASON_TOP_10", week_id: "S1" }]);
        expect(await badges(players[10]!.id)).toEqual([]);
    }, 60_000);

    it("tells every ranked player their final rank", async () => {
        const [a, b] = await field(2);
        const season = await insertSeason({ end: new Date(Date.now() - 1000) });
        await finalizeSeason(season.id);
        await new Promise((r) => setTimeout(r, 50));
        const { rows } = await pool.query<{ user_id: string; body: string }>(
            `SELECT user_id, body FROM notifications WHERE kind = 'COMPETITION_ENDED'`,
        );
        expect(rows.find((r) => r.user_id === a!.id)!.body).toContain("#1");
        expect(rows.find((r) => r.user_id === b!.id)!.body).toContain("#2");
    });

    it("leaves ELO, tiers and records alone", async () => {
        const [a] = await field(1);
        await pool.query(`UPDATE users SET elo_rating = 1234, win_count = 9 WHERE id = $1`, [a!.id]);
        const season = await insertSeason({ end: new Date(Date.now() - 1000) });
        await finalizeSeason(season.id);
        const { rows } = await pool.query(`SELECT elo_rating, win_count FROM users WHERE id = $1`, [a!.id]);
        expect(rows[0]).toEqual({ elo_rating: 1234, win_count: 9 });
    });

    it("the lifecycle job ends a season past end_at through this path", async () => {
        const [a] = await field(1);
        const season = await insertSeason({ end: new Date(Date.now() - 1000) });
        await competitionLifecycleJob.run(jobCtx);
        const { rows } = await pool.query(`SELECT status FROM competitions WHERE id = $1`, [season.id]);
        expect(rows[0].status).toBe("ENDED");
        expect(await badges(a!.id)).toHaveLength(1);
    });
});

describe("which season the tab shows", () => {
    it("is nothing with no seasons", async () => {
        expect(await getDisplaySeason()).toBeNull();
    });

    it("is the active season", async () => {
        const season = await insertSeason();
        expect((await getDisplaySeason())?.id).toBe(season.id);
    });

    it("is the ended season during its off-season", async () => {
        const season = await insertSeason({
            status: "ENDED", end: ago(1), offSeasonEnds: new Date(Date.now() + HOUR),
        });
        expect(await getDisplaySeason()).toMatchObject({ id: season.id, status: "ENDED" });
    });

    it("is nothing once the off-season is over", async () => {
        await insertSeason({ status: "ENDED", start: ago(200), end: ago(100), offSeasonEnds: ago(1) });
        expect(await getDisplaySeason()).toBeNull();
    });

    it("prefers an active season over a recent one", async () => {
        await insertSeason({ status: "ENDED", end: ago(1), offSeasonEnds: new Date(Date.now() + HOUR) });
        const active = await insertSeason();
        expect((await getDisplaySeason())?.id).toBe(active.id);
    });

    it("ignores upcoming and cancelled seasons", async () => {
        await insertSeason({ status: "CANCELLED", offSeasonEnds: new Date(Date.now() + HOUR) });
        await insertSeason({ status: "UPCOMING" });
        expect(await getDisplaySeason()).toBeNull();
    });
});

describe("GET /v1/seasons/current", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp({
            logger: false, disableKrakenFeed: true, disableTriggerEngine: true, disableJobRunner: true,
            disableOutboxWorker: true, disableLockSampler: true, disableOrchestrator: true, disableRateLimit: true,
        });
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
    });

    it("is public, and answers null with no season", async () => {
        const res = await app.inject({ method: "GET", url: "/v1/seasons/current" });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true, season: null });
    });

    it("returns what the tab needs", async () => {
        const season = await insertSeason();
        const res = await app.inject({ method: "GET", url: "/v1/seasons/current" });
        expect(res.json().season).toMatchObject({
            id: season.id, name: "Season 1", season_number: 1, status: "ACTIVE",
        });
    });
});

describe("creating a season", () => {
    const input = { name: "Season 1", days: 28 };
    const count = async () =>
        Number((await pool.query<{ count: string }>(`SELECT count(*) FROM competitions`)).rows[0]!.count);

    it("dry run: shows the plan and writes nothing", async () => {
        const plan = await createSeason(input, { apply: false });
        expect(plan).toMatchObject({ applied: false, seasonNumber: 1, name: "Season 1" });
        expect(plan.endAt.getTime() - plan.startAt.getTime()).toBe(28 * 24 * HOUR);
        expect(await count()).toBe(0);
    });

    it("apply: creates a global season the lifecycle job can start", async () => {
        const plan = await createSeason(input, { apply: true });
        expect(plan.applied).toBe(true);
        const { rows } = await pool.query(`SELECT * FROM competitions`);
        expect(rows[0]).toMatchObject({
            competition_type: "SEASON", tier: null, status: "UPCOMING", season_number: 1,
        });
        expect(rows[0].off_season_ends.getTime()).toBe(plan.endAt.getTime() + 3 * 24 * HOUR);
        await competitionLifecycleJob.run(jobCtx);
        expect((await getDisplaySeason())?.status).toBe("ACTIVE");
    });

    it("numbers seasons in order", async () => {
        await insertSeason({ status: "ENDED", end: ago(1) });
        expect((await createSeason(input, { apply: false })).seasonNumber).toBe(2);
    });

    it("refuses a second open season, even as a dry run", async () => {
        await insertSeason();
        await expect(createSeason(input, { apply: false })).rejects.toThrow(/already open/);
    });

    it("refuses a past start, a silly length and an empty name", async () => {
        await expect(createSeason({ ...input, start: ago(1) }, { apply: false })).rejects.toThrow(/past/);
        await expect(createSeason({ ...input, days: 0 }, { apply: false })).rejects.toThrow(/days/);
        await expect(createSeason({ ...input, days: 366 }, { apply: false })).rejects.toThrow(/days/);
        await expect(createSeason({ ...input, name: " " }, { apply: false })).rejects.toThrow(/name/);
    });
});

describe("closing a season", () => {
    const state = async (id: string) =>
        (await pool.query<{ status: string; end_at: Date }>(
            `SELECT status, end_at FROM competitions WHERE id = $1`, [id],
        )).rows[0]!;

    it("dry run: changes nothing", async () => {
        const season = await insertSeason();
        const plan = await closeSeason(season.id, { apply: false, cancel: false });
        expect(plan).toMatchObject({ applied: false, action: "close" });
        expect((await state(season.id)).end_at.getTime()).toBe(season.end.getTime());
    });

    it("apply: moves end_at to now, and the job then ends it", async () => {
        const season = await insertSeason();
        await closeSeason(season.id, { apply: true, cancel: false });
        expect((await state(season.id)).end_at.getTime()).toBeLessThan(season.end.getTime());
        expect((await state(season.id)).status).toBe("ACTIVE");
        await competitionLifecycleJob.run(jobCtx);
        expect((await state(season.id)).status).toBe("ENDED");
    });

    it("cancel: no ranks, no badges, and the tab drops it", async () => {
        const [a, b, c, d] = [await player("c_a"), await player("c_b"), await player("c_c"), await player("c_d")];
        for (const o of [b, c, d]) await played(a, o);
        const season = await insertSeason();
        await closeSeason(season.id, { apply: true, cancel: true });
        expect((await state(season.id)).status).toBe("CANCELLED");
        await competitionLifecycleJob.run(jobCtx);
        expect(await badges(a.id)).toEqual([]);
        expect(await getDisplaySeason()).toBeNull();
    });

    it("can cancel an upcoming season, but not close one", async () => {
        const season = await insertSeason({ status: "UPCOMING", start: new Date(Date.now() + HOUR) });
        await expect(closeSeason(season.id, { apply: true, cancel: false })).rejects.toThrow(/not active/);
        await closeSeason(season.id, { apply: true, cancel: true });
        expect((await state(season.id)).status).toBe("CANCELLED");
    });

    it("refuses an unknown id, a finished season, and a non-season competition", async () => {
        await expect(closeSeason("99999999-9999-4999-8999-999999999999", { apply: false, cancel: false }))
            .rejects.toThrow(/not found/);
        const ended = await insertSeason({ status: "ENDED", end: ago(1) });
        await expect(closeSeason(ended.id, { apply: true, cancel: true })).rejects.toThrow(/already/);
        const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO competitions (name, start_at, end_at, status) VALUES ('c', now(), now() + interval '1 day', 'ACTIVE') RETURNING id`,
        );
        await expect(closeSeason(rows[0]!.id, { apply: true, cancel: false })).rejects.toThrow(/not found/);
    });
});

describe("joining", () => {
    it("a season can't be joined: playing a match is what enters you", async () => {
        const user = await player("joiner");
        const season = await insertSeason();
        await expect(joinCompetition(user.id, season.id)).rejects.toThrow("competition_not_joinable");
    });
});
