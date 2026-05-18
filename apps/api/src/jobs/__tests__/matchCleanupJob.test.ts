/**
 * matchCleanupJob.test.ts — integration tests for the match-cleanup job's
 * resolution paths:
 *   - expired ACTIVE with FILLED orders  → completeMatch    → COMPLETED
 *   - expired ACTIVE with zero fills     → mutualForfeitMatch → FORFEITED
 *   - stale PENDING                      → CANCELLED
 *   - error isolation: one failing match does not break the tick
 *   - idempotency: ELO is applied exactly once across repeated runs
 *
 * Integration test — hits the real Postgres at DATABASE_URL. Mirrors the
 * fixture pattern of matchScopedPositions.test.ts (direct pool.query setup).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../../db/pool";
import { logger } from "../../observability/logContext";
import { applyFillToPositionTx } from "../../analytics/positionRepo";
import { matchCleanupJob } from "../definitions/matchCleanupJob";
import { ELO_TABLE } from "../../competitions/eloService";

type Ctx = {
    challengerId: string;
    opponentId: string;
    baseAssetId: string;
    quoteAssetId: string;
    pairId: string;
    pairSymbol: string;
    matchId: string;
};

async function setupCtx(lastPrice: string): Promise<Ctx> {
    const uid = Math.random().toString(36).slice(2, 7);

    const { rows: challengerRows } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, email_normalized, password_hash, role)
         VALUES ($1, LOWER($1), 'test-hash', 'USER')
         RETURNING id`,
        [`mcj-ch-${uid}@test.local`],
    );
    const { rows: opponentRows } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, email_normalized, password_hash, role)
         VALUES ($1, LOWER($1), 'test-hash', 'USER')
         RETURNING id`,
        [`mcj-op-${uid}@test.local`],
    );
    const challengerId = challengerRows[0]!.id;
    const opponentId = opponentRows[0]!.id;

    const { rows: baseRows } = await pool.query<{ id: string }>(
        `INSERT INTO assets (symbol, name, decimals)
         VALUES ($1, $2, 8) RETURNING id`,
        [`B${uid.toUpperCase()}`, `BTC-${uid}`],
    );
    const { rows: quoteRows } = await pool.query<{ id: string }>(
        `INSERT INTO assets (symbol, name, decimals)
         VALUES ($1, $2, 2) RETURNING id`,
        [`Q${uid.toUpperCase()}`, `USD-${uid}`],
    );
    const baseAssetId = baseRows[0]!.id;
    const quoteAssetId = quoteRows[0]!.id;

    const pairSymbol = `P${uid.toUpperCase()}/USD`;
    const { rows: pairRows } = await pool.query<{ id: string }>(
        `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active, last_price, fee_bps)
         VALUES ($1, $2, $3, true, $4, 30)
         RETURNING id`,
        [baseAssetId, quoteAssetId, pairSymbol, lastPrice],
    );
    const pairId = pairRows[0]!.id;

    // Created ACTIVE with ends_at in the future — individual tests expire it
    // (or roll it back to PENDING) as needed.
    const { rows: matchRows } = await pool.query<{ id: string }>(
        `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status, started_at, ends_at)
         VALUES ($1, $2, 24, '50000', 'ACTIVE', now() - interval '1 hour', now() + interval '23 hours')
         RETURNING id`,
        [challengerId, opponentId],
    );
    const matchId = matchRows[0]!.id;

    return { challengerId, opponentId, baseAssetId, quoteAssetId, pairId, pairSymbol, matchId };
}

async function teardownCtx(ctx: Ctx): Promise<void> {
    await pool.query(`UPDATE positions SET match_id = NULL WHERE match_id = $1`, [ctx.matchId]);
    await pool.query(`UPDATE orders SET match_id = NULL WHERE match_id = $1`, [ctx.matchId]);
    await pool.query(`DELETE FROM match_elo_results WHERE match_id = $1`, [ctx.matchId]);
    await pool.query(`DELETE FROM elo_history WHERE match_id = $1`, [ctx.matchId]);
    await pool.query(`DELETE FROM match_positions WHERE match_id = $1`, [ctx.matchId]);
    await pool.query(`DELETE FROM match_allowed_pairs WHERE match_id = $1`, [ctx.matchId]);
    await pool.query(`DELETE FROM matches WHERE id = $1`, [ctx.matchId]);
    await pool.query(
        `DELETE FROM trades
         WHERE pair_id = $1
            OR buy_order_id IN (SELECT id FROM orders WHERE pair_id = $1)
            OR sell_order_id IN (SELECT id FROM orders WHERE pair_id = $1)`,
        [ctx.pairId],
    );
    await pool.query(`DELETE FROM orders WHERE pair_id = $1`, [ctx.pairId]);
    await pool.query(`DELETE FROM positions WHERE pair_id = $1`, [ctx.pairId]);
    await pool.query(`DELETE FROM user_tier_history WHERE user_id = ANY($1)`, [[ctx.challengerId, ctx.opponentId]]);
    await pool.query(`DELETE FROM user_tiers WHERE user_id = ANY($1)`, [[ctx.challengerId, ctx.opponentId]]);
    await pool.query(`DELETE FROM equity_snapshots WHERE user_id = $1 OR user_id = $2`, [ctx.challengerId, ctx.opponentId]);
    await pool.query(`DELETE FROM trading_pairs WHERE id = $1`, [ctx.pairId]);
    await pool.query(`DELETE FROM assets WHERE id = ANY($1)`, [[ctx.baseAssetId, ctx.quoteAssetId]]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[ctx.challengerId, ctx.opponentId]]);
}

/** Insert a single FILLED order scoped to the match (routes the job to completeMatch). */
async function insertFilledOrder(ctx: Ctx): Promise<void> {
    await pool.query(
        `INSERT INTO orders (
            user_id, pair_id, side, type, limit_price,
            qty, qty_filled, status,
            reserved_wallet_id, reserved_amount, reserved_consumed,
            competition_id, match_id
         ) VALUES ($1, $2, 'BUY', 'MARKET', NULL,
                   '0.01000000', '0.01000000', 'FILLED',
                   NULL, '0', '0',
                   NULL, $3::uuid)`,
        [ctx.challengerId, ctx.pairId, ctx.matchId],
    );
}

/** Open a match-scoped long position for the challenger (BUY 0.1 @ 50000). */
async function openChallengerPosition(ctx: Ctx): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await applyFillToPositionTx(client, {
            userId: ctx.challengerId,
            pairId: ctx.pairId,
            side: "BUY",
            qty: "0.10000000",
            price: "50000.00000000",
            feeQuote: "0",
            ts: Date.now(),
            competitionId: null,
            matchId: ctx.matchId,
        });
        await client.query("COMMIT");
    } finally {
        client.release();
    }
}

/** Push a match's ends_at into the past so the job treats it as expired. */
async function expireMatch(matchId: string): Promise<void> {
    await pool.query(
        `UPDATE matches SET ends_at = now() - interval '10 minutes' WHERE id = $1`,
        [matchId],
    );
}

async function runCleanupJob(): Promise<void> {
    await matchCleanupJob.run({
        pool,
        logger,
        signal: new AbortController().signal,
    });
}

describe("matchCleanupJob — match resolution on timer expiry", () => {
    describe("Test 1 — expired ACTIVE with fills → COMPLETED with ELO", () => {
        let ctx: Ctx;
        beforeAll(async () => {
            // Position opened at 50000, last_price 52000 → close books +$200
            // for the challenger, so the challenger wins the match.
            ctx = await setupCtx("52000.00000000");
            await openChallengerPosition(ctx);
            await insertFilledOrder(ctx);
            await expireMatch(ctx.matchId);
        });
        afterAll(async () => {
            await teardownCtx(ctx).catch(() => {});
        });

        it("job routes the match to completeMatch: COMPLETED, ELO resolved", async () => {
            await runCleanupJob();

            const { rows } = await pool.query<{
                status: string; winner_id: string | null; elo_resolved: boolean;
            }>(
                `SELECT status, winner_id, elo_resolved FROM matches WHERE id = $1`,
                [ctx.matchId],
            );
            expect(rows[0]!.status).toBe("COMPLETED");
            expect(rows[0]!.winner_id).toBe(ctx.challengerId);
            expect(rows[0]!.elo_resolved).toBe(true);

            // match_elo_results row written by resolveMatchElo.
            const { rows: eloResult } = await pool.query(
                `SELECT 1 FROM match_elo_results WHERE match_id = $1`,
                [ctx.matchId],
            );
            expect(eloResult.length).toBe(1);

            // Each player has an elo_history row for this match.
            const { rows: histRows } = await pool.query<{ user_id: string; change_reason: string }>(
                `SELECT user_id, change_reason FROM elo_history WHERE match_id = $1`,
                [ctx.matchId],
            );
            expect(histRows.length).toBe(2);
            const reasons = new Map(histRows.map((r) => [r.user_id, r.change_reason]));
            expect(reasons.get(ctx.challengerId)).toBe("MATCH_WIN");
            expect(reasons.get(ctx.opponentId)).toBe("MATCH_LOSS");
        });
    });

    describe("Test 2 — expired ACTIVE with zero fills → mutual forfeit", () => {
        let ctx: Ctx;
        beforeAll(async () => {
            ctx = await setupCtx("50000.00000000");
            await expireMatch(ctx.matchId);
        });
        afterAll(async () => {
            await teardownCtx(ctx).catch(() => {});
        });

        it("job routes the match to mutualForfeitMatch: FORFEITED, both players lose ELO", async () => {
            await runCleanupJob();

            const { rows } = await pool.query<{
                status: string; winner_id: string | null; elo_resolved: boolean;
            }>(
                `SELECT status, winner_id, elo_resolved FROM matches WHERE id = $1`,
                [ctx.matchId],
            );
            expect(rows[0]!.status).toBe("FORFEITED");
            expect(rows[0]!.winner_id).toBeNull();
            expect(rows[0]!.elo_resolved).toBe(true);

            // No match_elo_results row for a no-winner result.
            const { rows: eloResult } = await pool.query(
                `SELECT 1 FROM match_elo_results WHERE match_id = $1`,
                [ctx.matchId],
            );
            expect(eloResult.length).toBe(0);

            // Both players: one MATCH_LOSS elo_history row, negative delta.
            // Fresh users start at elo 800, ROOKIE tier → ELO_TABLE.ROOKIE.lose.
            const expectedDelta = ELO_TABLE.ROOKIE.lose;
            expect(expectedDelta).toBeLessThan(0);

            for (const userId of [ctx.challengerId, ctx.opponentId]) {
                const { rows: histRows } = await pool.query<{
                    old_elo: number; new_elo: number; change_reason: string;
                }>(
                    `SELECT old_elo, new_elo, change_reason
                     FROM elo_history WHERE match_id = $1 AND user_id = $2`,
                    [ctx.matchId, userId],
                );
                expect(histRows.length).toBe(1);
                expect(histRows[0]!.change_reason).toBe("MATCH_LOSS");
                expect(histRows[0]!.new_elo).toBe(histRows[0]!.old_elo + expectedDelta);

                const { rows: userRows } = await pool.query<{
                    elo_rating: number; loss_count: number; loss_streak: number; win_streak: number;
                }>(
                    `SELECT elo_rating, loss_count, loss_streak, win_streak FROM users WHERE id = $1`,
                    [userId],
                );
                expect(userRows[0]!.elo_rating).toBe(800 + expectedDelta);
                expect(userRows[0]!.loss_count).toBe(1);
                expect(userRows[0]!.loss_streak).toBe(1);
                expect(userRows[0]!.win_streak).toBe(0);
            }
        });
    });

    describe("Test 3 — stale PENDING match → CANCELLED (unchanged behavior)", () => {
        let ctx: Ctx;
        beforeAll(async () => {
            ctx = await setupCtx("50000.00000000");
            // Roll back to PENDING and age it past the 2-hour cutoff.
            await pool.query(
                `UPDATE matches
                 SET status = 'PENDING', started_at = NULL, ends_at = NULL,
                     created_at = now() - interval '3 hours'
                 WHERE id = $1`,
                [ctx.matchId],
            );
        });
        afterAll(async () => {
            await teardownCtx(ctx).catch(() => {});
        });

        it("job cancels the stale PENDING match", async () => {
            await runCleanupJob();
            const { rows } = await pool.query<{ status: string }>(
                `SELECT status FROM matches WHERE id = $1`,
                [ctx.matchId],
            );
            expect(rows[0]!.status).toBe("CANCELLED");
        });
    });

    describe("Test 4 — error isolation: one failing match does not break the tick", () => {
        // The "broken" match is forced to fail by pre-inserting a
        // match_elo_results row (match_id is PRIMARY KEY): completeMatch →
        // resolveMatchElo then hits a duplicate-key violation on its own
        // INSERT, throws, and rolls back — leaving the match ACTIVE.
        let broken: Ctx;
        let healthy: Ctx;
        beforeAll(async () => {
            broken = await setupCtx("52000.00000000");
            await openChallengerPosition(broken);
            await insertFilledOrder(broken);
            await expireMatch(broken.matchId);
            // Pre-existing match_elo_results row → resolveMatchElo's INSERT collides.
            await pool.query(
                `INSERT INTO match_elo_results (
                    match_id, winner_id, loser_id,
                    winner_old_elo, winner_new_elo, winner_delta,
                    loser_old_elo, loser_new_elo, loser_delta,
                    winner_tier_before, winner_tier_after,
                    loser_tier_before, loser_tier_after
                 ) VALUES ($1,$2,$3,800,800,0,800,800,0,'ROOKIE','ROOKIE','ROOKIE','ROOKIE')`,
                [broken.matchId, broken.challengerId, broken.opponentId],
            );

            // A healthy zero-fill match expiring in the same tick.
            healthy = await setupCtx("50000.00000000");
            await expireMatch(healthy.matchId);
        });
        afterAll(async () => {
            await teardownCtx(broken).catch(() => {});
            await teardownCtx(healthy).catch(() => {});
        });

        it("the failing match stays ACTIVE; the healthy match still resolves", async () => {
            // Job must not throw — the per-match catch isolates the failure.
            await expect(runCleanupJob()).resolves.toBeUndefined();

            const { rows: brokenRows } = await pool.query<{ status: string }>(
                `SELECT status FROM matches WHERE id = $1`,
                [broken.matchId],
            );
            expect(brokenRows[0]!.status).toBe("ACTIVE");

            const { rows: healthyRows } = await pool.query<{ status: string }>(
                `SELECT status FROM matches WHERE id = $1`,
                [healthy.matchId],
            );
            expect(healthyRows[0]!.status).toBe("FORFEITED");
        });
    });

    describe("Test 5 — idempotency: completeMatch path applies ELO exactly once", () => {
        let ctx: Ctx;
        beforeAll(async () => {
            ctx = await setupCtx("52000.00000000");
            await openChallengerPosition(ctx);
            await insertFilledOrder(ctx);
            await expireMatch(ctx.matchId);
        });
        afterAll(async () => {
            await teardownCtx(ctx).catch(() => {});
        });

        it("two consecutive job runs leave the match COMPLETED with one elo_history row per player", async () => {
            await runCleanupJob();
            await runCleanupJob();

            const { rows } = await pool.query<{ status: string; elo_resolved: boolean }>(
                `SELECT status, elo_resolved FROM matches WHERE id = $1`,
                [ctx.matchId],
            );
            expect(rows[0]!.status).toBe("COMPLETED");
            expect(rows[0]!.elo_resolved).toBe(true);

            for (const userId of [ctx.challengerId, ctx.opponentId]) {
                const { rows: histRows } = await pool.query<{ count: string }>(
                    `SELECT count(*) FROM elo_history WHERE match_id = $1 AND user_id = $2`,
                    [ctx.matchId, userId],
                );
                expect(parseInt(histRows[0]!.count, 10)).toBe(1);
            }
        });
    });

    describe("Test 6 — idempotency: mutual-forfeit path applies the penalty exactly once", () => {
        let ctx: Ctx;
        beforeAll(async () => {
            ctx = await setupCtx("50000.00000000");
            await expireMatch(ctx.matchId);
        });
        afterAll(async () => {
            await teardownCtx(ctx).catch(() => {});
        });

        it("two consecutive job runs leave one MATCH_LOSS row per player", async () => {
            await runCleanupJob();
            await runCleanupJob();

            const { rows } = await pool.query<{ status: string }>(
                `SELECT status FROM matches WHERE id = $1`,
                [ctx.matchId],
            );
            expect(rows[0]!.status).toBe("FORFEITED");

            for (const userId of [ctx.challengerId, ctx.opponentId]) {
                const { rows: histRows } = await pool.query<{ count: string }>(
                    `SELECT count(*) FROM elo_history
                     WHERE match_id = $1 AND user_id = $2 AND change_reason = 'MATCH_LOSS'`,
                    [ctx.matchId, userId],
                );
                expect(parseInt(histRows[0]!.count, 10)).toBe(1);

                // ELO penalty applied once: rating moved by exactly one loss delta.
                const { rows: userRows } = await pool.query<{ elo_rating: number; loss_count: number }>(
                    `SELECT elo_rating, loss_count FROM users WHERE id = $1`,
                    [userId],
                );
                expect(userRows[0]!.elo_rating).toBe(800 + ELO_TABLE.ROOKIE.lose);
                expect(userRows[0]!.loss_count).toBe(1);
            }
        });
    });
});
