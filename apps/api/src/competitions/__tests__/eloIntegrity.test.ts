/**
 * ELO_INTEGRITY_ENABLED: the anti-farming rules for 1v1 ELO and season score.
 *
 * The scenario tests drive the real resolveMatchElo against match rows with
 * controlled times and per-player activity. Each scenario runs with the flag
 * off (today's numbers) and on (the new rules). The real-path tests run
 * createMatch → acceptMatch → trades → forfeitMatch / completeMatch.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../notifications/notificationService", () => ({
    notifyTriggerFired: vi.fn().mockResolvedValue(undefined),
    notifyCompetitionEnded: vi.fn().mockResolvedValue(undefined),
}));

import { pool } from "../../db/pool";
import { config } from "../../config";
import { ensureMigrations, resetTestData } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { placeOrderWithSnapshot } from "../../trading/phase6OrderService";
import { resolveMatchElo } from "../eloService";
import type { MatchActivity } from "../eloIntegrity";
import { createMatch, acceptMatch, completeMatch, forfeitMatch, mutualForfeitMatch } from "../matchService";
import { refreshSeasonLeaderboard } from "../seasonService";

const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(Date.now() - ms);
const QUALIFIED: MatchActivity = { fills: 2, notional: 10_000 };

let n = 0;
async function player(elo = 800, tier?: string, winStreak = 0): Promise<string> {
    const u = await createTestUser(pool, { email: `elo${++n}@test.local` });
    await pool.query(`UPDATE users SET elo_rating = $1, win_streak = $2 WHERE id = $3`, [elo, winStreak, u.id]);
    if (tier) await pool.query(`INSERT INTO user_tiers (user_id, tier) VALUES ($1, $2)`, [u.id, tier]);
    return u.id;
}

/** A finished match row, as completeMatch / forfeitMatch leave it before ELO. */
async function finished(
    winner: string,
    loser: string,
    at: Date,
    over: { forfeitBy?: string; startedAt?: Date; hours?: number } = {},
): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status,
                              winner_id, forfeit_user_id, started_at, completed_at)
         VALUES ($1, $2, $3, 50000, $4, $5, $6, $7, $8) RETURNING id`,
        [
            winner, loser, over.hours ?? 0.25, over.forfeitBy ? "FORFEITED" : "COMPLETED", winner,
            over.forfeitBy ?? null, over.startedAt ?? new Date(at.getTime() - 15 * MIN), at,
        ],
    );
    return rows[0]!.id;
}

async function resolve(matchId: string, activity?: Map<string, MatchActivity>) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const r = await resolveMatchElo(matchId, client, activity ? { activity } : undefined);
        await client.query("COMMIT");
        return r;
    } finally {
        client.release();
    }
}

/** Play a sequence: each entry is [winner, loser, completedAt]. Both qualify. */
async function play(seq: [string, string, Date][]): Promise<void> {
    for (const [w, l, at] of seq) {
        const id = await finished(w, l, at);
        await resolve(id, new Map([[w, QUALIFIED], [l, QUALIFIED]]));
    }
}

const user = async (id: string) =>
    (await pool.query<{ elo_rating: number; win_count: number; loss_count: number; win_streak: number; loss_streak: number }>(
        `SELECT elo_rating, win_count, loss_count, win_streak, loss_streak FROM users WHERE id = $1`, [id],
    )).rows[0]!;
const elo = async (id: string) => (await user(id)).elo_rating;

/** Ten matches inside one hour, 6 minutes apart. */
function hourOf(pairs: [string, string][]): [string, string, Date][] {
    const base = Date.now() - 2 * HOUR;
    return pairs.map(([w, l], i) => [w, l, new Date(base + i * 6 * MIN)]);
}

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    await resetTestData();
    await pool.query(`DELETE FROM competitions`);
    config.eloIntegrityEnabled = false;
});

afterEach(() => {
    config.eloIntegrityEnabled = false;
});

describe.each([false, true])("ELO_INTEGRITY_ENABLED=%s scenarios", (on) => {
    beforeEach(() => {
        config.eloIntegrityEnabled = on;
    });

    it("two friends alternating 10 wins in an hour", async () => {
        const [a, b] = [await player(), await player()];
        await play(hourOf(Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? [a, b] : [b, a]))));
        if (!on) {
            expect([await elo(a), await elo(b)]).toEqual([872, 875]); // +72 / +75
        } else {
            // +15/−3, then +8/−1 (no upset: 18-point gap < 50), then winner unrated, loser −0
            expect([await elo(a), await elo(b)]).toEqual([814, 805]);
            expect(await user(a)).toMatchObject({ win_count: 1, loss_count: 5 });
            expect(await user(b)).toMatchObject({ win_count: 1, loss_count: 5 });
        }
    });

    it("one friend feeding the other all 10 wins", async () => {
        const [a, b] = [await player(), await player()];
        await play(hourOf(Array.from({ length: 10 }, () => [a, b] as [string, string])));
        if (!on) {
            expect([await elo(a), await elo(b)]).toEqual([1011, 770]); // +211 / −30
        } else {
            expect([await elo(a), await elo(b)]).toEqual([823, 796]); // +23 / −4
            expect(await user(a)).toMatchObject({ win_count: 2, win_streak: 2 });
            expect(await user(b)).toMatchObject({ loss_count: 10, loss_streak: 10 });
        }
    });

    it("an instant forfeit with zero trades", async () => {
        const [a, b] = [await player(), await player()];
        const at = ago(HOUR);
        const id = await finished(b, a, at, { forfeitBy: a, startedAt: new Date(at.getTime() - 5_000) });
        await resolve(id, new Map());
        if (!on) {
            expect([await elo(b), await elo(a)]).toEqual([815, 797]);
        } else {
            expect([await elo(b), await elo(a)]).toEqual([800, 797]);
            expect(await user(b)).toMatchObject({ win_count: 0, win_streak: 0 });
            expect(await user(a)).toMatchObject({ loss_count: 1 });
        }
    });

    it("a legit upset win", async () => {
        const rookie = await player(820);
        const pro = await player(1210, "PRO");
        const pro2 = await player(1250, "PRO");
        const elite = await player(1600, "ELITE");
        await play([[rookie, pro, ago(2 * HOUR)], [pro2, elite, ago(HOUR)]]);
        expect([await elo(rookie), await elo(pro)]).toEqual([838, 1202]); // +18 / −8
        expect([await elo(pro2), await elo(elite)]).toEqual([1265, 1585]); // +15 / −15
    });

    it("a new player's first 5 matches", async () => {
        const me = await player();
        const opp = [await player(800), await player(820), await player(850), await player(900), await player(800)];
        await play([
            [me, opp[0]!, ago(5 * HOUR)],
            [me, opp[1]!, ago(4 * HOUR)],
            [me, opp[2]!, ago(3 * HOUR)],
            [opp[3]!, me, ago(2 * HOUR)],
            [me, opp[4]!, ago(HOUR)],
        ]);
        // Off: +15, +18, +22, −3, +15. On: +15, +15, +18, −3, +15 (the
        // 5- and 20-point gaps no longer earn the upset bonus).
        expect(await elo(me)).toBe(on ? 860 : 867);
        expect(await user(me)).toMatchObject({ win_count: 4, loss_count: 1, win_streak: 1 });
    });
});

describe("ELO_INTEGRITY_ENABLED rules", () => {
    beforeEach(() => {
        config.eloIntegrityEnabled = true;
    });

    it("upset bonus needs the loser 50+ ELO higher", async () => {
        const [w1, l1, w2, l2] = [await player(760), await player(810), await player(761), await player(810)];
        await play([[w1, l1, ago(2 * HOUR)], [w2, l2, ago(HOUR)]]);
        expect(await elo(w1)).toBe(778);
        expect(await elo(w2)).toBe(776);
    });

    it("the winner needs the loser to have traded too", async () => {
        const [a, b] = [await player(), await player()];
        const id = await finished(a, b, ago(HOUR));
        await resolve(id, new Map([[a, QUALIFIED], [b, { fills: 1, notional: 4_999 }]]));
        expect([await elo(a), await elo(b)]).toEqual([800, 797]);
        const { rows } = await pool.query(`SELECT winner_delta, winner_unrated_reason FROM match_elo_results WHERE match_id = $1`, [id]);
        expect(rows[0]).toEqual({ winner_delta: 0, winner_unrated_reason: "NOT_QUALIFIED" });
    });

    it("a forfeit after the early window is rated", async () => {
        const [a, b] = [await player(), await player()];
        const at = ago(HOUR);
        // 15-minute match: the window is 3m45s.
        const id = await finished(a, b, at, { forfeitBy: b, startedAt: new Date(at.getTime() - 4 * MIN) });
        await resolve(id, new Map([[a, QUALIFIED], [b, QUALIFIED]]));
        expect([await elo(a), await elo(b)]).toEqual([815, 797]);
    });

    it("an early forfeit in a long match uses the 15-minute cap", async () => {
        const [a, b] = [await player(), await player()];
        const at = ago(HOUR);
        const id = await finished(a, b, at, { forfeitBy: b, hours: 24, startedAt: new Date(at.getTime() - 14 * MIN) });
        await resolve(id, new Map([[a, QUALIFIED], [b, QUALIFIED]]));
        expect([await elo(a), await elo(b)]).toEqual([800, 797]);
    });

    it("the 24h window rolls: a third match a day later is full value", async () => {
        const [a, b] = [await player(), await player()];
        await play([[a, b, ago(30 * HOUR)], [a, b, ago(29 * HOUR)], [a, b, ago(HOUR)]]);
        expect(await elo(a)).toBe(800 + 15 + 8 + 18); // third win: streak 3 → ×1.2
    });
});

describe("ELO_INTEGRITY_ENABLED season score", () => {
    beforeEach(() => {
        config.eloIntegrityEnabled = true;
    });

    async function season(startedHoursAgo: number): Promise<string> {
        const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO competitions (name, start_at, end_at, status, competition_type, season_number)
             VALUES ('S', $1, $2, 'ACTIVE', 'SEASON', 1) RETURNING id`,
            [ago(startedHoursAgo * HOUR), new Date(Date.now() + 48 * HOUR)],
        );
        return rows[0]!.id;
    }
    async function board(id: string) {
        await refreshSeasonLeaderboard(id);
        return (await pool.query<{ user_id: string; rank: number; nuanced_score: string; trades_count: number; win_rate: string }>(
            `SELECT user_id, rank, nuanced_score::float8::text AS nuanced_score, trades_count, win_rate::float8::text AS win_rate
             FROM competition_leaderboard WHERE competition_id = $1 ORDER BY rank`, [id],
        )).rows;
    }

    it("a pre-season win streak doesn't multiply season points", async () => {
        const s = await season(10);
        const [a, b] = [await player(800, undefined, 9), await player()];
        await play([[a, b, ago(HOUR)]]);
        expect(await elo(a)).toBe(830); // ELO keeps the lifetime streak: 15 × 2
        expect((await board(s))[0]).toMatchObject({ user_id: a, nuanced_score: "15" });
    });

    it("weights the same opponent 100/50/25 across the season", async () => {
        const s = await season(200);
        const [a, b] = [await player(), await player()];
        // 25h apart, so every match is the pair's first in its 24h window.
        await play(Array.from({ length: 7 }, (_, i) => [a, b, ago((7 - i) * 25 * HOUR)] as [string, string, Date]));
        // ELO 15, 15, 18, 18, 23, 23, 23 × 1, 1, 1, .5, .5, .5, .25
        expect(await board(s)).toEqual([
            { user_id: a, rank: 1, nuanced_score: "85.75", trades_count: 7, win_rate: "100" },
            { user_id: b, rank: 2, nuanced_score: "-14.25", trades_count: 7, win_rate: "0" },
        ]);
    });

    it("an unrated win and a match without stored points stay off the board", async () => {
        const s = await season(10);
        const [a, b, c, d] = [await player(), await player(), await player(), await player()];
        const id = await finished(a, b, ago(2 * HOUR));
        await resolve(id, new Map());
        // A match resolved before the flag: elo_history only, no stored points.
        const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO matches (challenger_id, opponent_id, duration_hours, status, winner_id, completed_at, elo_resolved)
             VALUES ($1, $2, 24, 'COMPLETED', $1, $3, true) RETURNING id`, [c, d, ago(HOUR)]);
        await pool.query(
            `INSERT INTO elo_history (user_id, old_elo, new_elo, change_reason, match_id)
             VALUES ($1, 800, 815, 'MATCH_WIN', $3), ($2, 800, 797, 'MATCH_LOSS', $3)`, [c, d, rows[0]!.id]);
        expect(await board(s)).toEqual([
            { user_id: b, rank: 1, nuanced_score: "-3", trades_count: 1, win_rate: "0" },
        ]);
    });
});

describe("ELO_INTEGRITY_ENABLED real match paths", () => {
    beforeEach(() => {
        config.eloIntegrityEnabled = true;
        clearReferenceBooks();
    });

    async function setup() {
        const { pair, btcAsset, usdAsset } = await createTestAssetAndPair(pool);
        const mk = async () => {
            const id = await player();
            await createTestWallets(pool, id, btcAsset.id, usdAsset.id, "0.00000000", "100000.00000000");
            return id;
        };
        return { pairId: pair.id, a: await mk(), b: await mk() };
    }

    it("an instant forfeit with no trades: winner unrated, forfeiter −3", async () => {
        const { pairId, a, b } = await setup();
        const m = await createMatch(a, b, 0.25, [pairId]);
        await acceptMatch(m.id, b);
        await forfeitMatch(m.id, a);
        expect([await elo(b), await elo(a)]).toEqual([800, 797]);
        const { rows } = await pool.query(`SELECT winner_unrated_reason FROM match_elo_results WHERE match_id = $1`, [m.id]);
        expect(rows[0]!.winner_unrated_reason).toBe("EARLY_FORFEIT");
    });

    it("both players with 0 fills: both take the tier loss, as today, and it scores", async () => {
        const { pairId, a, b } = await setup();
        const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO competitions (name, start_at, end_at, status, competition_type, season_number)
             VALUES ('S', $1, $2, 'ACTIVE', 'SEASON', 1) RETURNING id`, [ago(HOUR), new Date(Date.now() + HOUR)]);
        const m = await createMatch(a, b, 0.25, [pairId]);
        await acceptMatch(m.id, b);
        await mutualForfeitMatch(m.id);
        expect([await elo(a), await elo(b)]).toEqual([797, 797]);
        await refreshSeasonLeaderboard(rows[0]!.id);
        const scores = (await pool.query(`SELECT nuanced_score::float8 AS s FROM competition_leaderboard`)).rows.map((r) => r.s);
        expect(scores).toEqual([-3, -3]);
    });

    it("match-end force-closes don't count toward the minimum notional", async () => {
        const { pairId, a, b } = await setup();
        const m = await createMatch(a, b, 24, [pairId]);
        await acceptMatch(m.id, b);
        seedReferenceBook(pairId, "83000", "83010");
        const mkt = (uid: string, side: "BUY" | "SELL", qty: string) =>
            placeOrderWithSnapshot(uid, { pairId, side, type: "MARKET", qty }, undefined, undefined, null, m.id);
        await mkt(a, "BUY", "0.03600000"); // ≈ $2,988: 6% of $50k, under the 10% minimum
        await mkt(b, "SELL", "0.10000000"); // ≈ $8,300
        seedReferenceBook(pairId, "85000", "85010");
        await completeMatch(m.id); // the force-close would take a past $5k
        const { rows } = await pool.query(`SELECT winner_id, winner_delta, winner_unrated_reason FROM match_elo_results WHERE match_id = $1`, [m.id]);
        expect(rows[0]).toEqual({ winner_id: a, winner_delta: 0, winner_unrated_reason: "NOT_QUALIFIED" });
        expect(await elo(b)).toBe(797);
    });
});
