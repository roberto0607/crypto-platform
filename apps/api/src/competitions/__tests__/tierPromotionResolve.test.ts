/**
 * tierPromotionResolve.test.ts — regression guard for migration 069.
 *
 * Forfeiting/completing a match 500'd (Postgres 23514) whenever the winner
 * crossed a tier-promotion boundary: resolveMatchElo → updateUserTierTx wrote
 * tier='PRO' into user_tiers, but user_tiers_tier_check only allowed the
 * weekly-competition 6-tier vocabulary (no PRO/ELITE). The whole forfeit
 * transaction rolled back → 500 → match stuck ACTIVE.
 *
 * This test seeds a winner that promotes ROOKIE → PRO on the win, then forfeits.
 * It FAILS on pre-069 schema (the tier write violates the old constraint and
 * forfeitMatch throws) and PASSES once 069 widens the constraint to the union
 * of both tier vocabularies.
 *
 * Integration test — hits the real Postgres at DATABASE_URL.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pool } from "../../db/pool";
import { forfeitMatch } from "../matchService";

type Ctx = { challengerId: string; opponentId: string; matchId: string };

async function setup(): Promise<Ctx> {
    const uid = Math.random().toString(36).slice(2, 7);

    // Challenger will forfeit → opponent wins. Seed the opponent (winner) so the
    // win crosses the PRO promotion threshold: elo >= 1200 AND win_count >= 5
    // (see PROMOTION_THRESHOLDS in eloService). On a ROOKIE win (+15) from 1200
    // → 1215 >= 1200, win_count 5 → 6 >= 5, so checkPromotion returns PRO.
    const { rows: ch } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, email_normalized, password_hash, role)
         VALUES ($1, LOWER($1), 'test-hash', 'USER') RETURNING id`,
        [`tpr-ch-${uid}@test.local`],
    );
    const { rows: op } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, email_normalized, password_hash, role, elo_rating, win_count, win_streak)
         VALUES ($1, LOWER($1), 'test-hash', 'USER', 1200, 5, 0) RETURNING id`,
        [`tpr-op-${uid}@test.local`],
    );
    const challengerId = ch[0]!.id;
    const opponentId = op[0]!.id;

    const { rows: m } = await pool.query<{ id: string }>(
        `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status, started_at, ends_at)
         VALUES ($1, $2, 24, '50000', 'ACTIVE', now() - interval '1 hour', now() + interval '23 hours')
         RETURNING id`,
        [challengerId, opponentId],
    );
    return { challengerId, opponentId, matchId: m[0]!.id };
}

async function teardown(ctx: Ctx): Promise<void> {
    await pool.query(`DELETE FROM match_elo_results WHERE match_id = $1`, [ctx.matchId]);
    await pool.query(`DELETE FROM elo_history WHERE match_id = $1`, [ctx.matchId]);
    await pool.query(`DELETE FROM matches WHERE id = $1`, [ctx.matchId]);
    await pool.query(`DELETE FROM user_tier_history WHERE user_id = ANY($1)`, [[ctx.challengerId, ctx.opponentId]]);
    await pool.query(`DELETE FROM user_tiers WHERE user_id = ANY($1)`, [[ctx.challengerId, ctx.opponentId]]);
    await pool.query(`DELETE FROM user_badges WHERE user_id = ANY($1)`, [[ctx.challengerId, ctx.opponentId]]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[ctx.challengerId, ctx.opponentId]]);
}

describe("tier promotion on match resolution (migration 069 regression)", () => {
    let ctx: Ctx;
    beforeEach(async () => { ctx = await setup(); });
    afterEach(async () => { await teardown(ctx).catch(() => {}); });

    it("forfeit that promotes the winner ROOKIE→PRO succeeds (constraint allows PRO)", async () => {
        // Pre-069 this throws 23514 (user_tiers_tier_check rejects 'PRO') and the
        // match stays ACTIVE. Post-069 it resolves cleanly.
        const match = await forfeitMatch(ctx.matchId, ctx.challengerId);
        expect(match.status).toBe("FORFEITED");
        expect(match.winner_id).toBe(ctx.opponentId);

        // The promotion write landed: winner is now PRO in user_tiers.
        const { rows } = await pool.query<{ tier: string }>(
            `SELECT tier FROM user_tiers WHERE user_id = $1`,
            [ctx.opponentId],
        );
        expect(rows[0]?.tier).toBe("PRO");
    });
});
