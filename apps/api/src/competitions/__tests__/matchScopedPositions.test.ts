/**
 * matchScopedPositions.test.ts — end-to-end test for match-scoped position
 * lifecycle: fill-during-match creates a match-scoped row, completeMatch
 * closes it and books realized P&L, forfeitMatch does the same and the
 * forfeiter's loss still counts toward match stats.
 *
 * Integration test — hits the real Postgres at DATABASE_URL. Uses pool.query
 * to set up users/pairs/matches directly (same pattern as matchService.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../../db/pool";
import { applyFillToPositionTx } from "../../analytics/positionRepo";
import { completeMatch, forfeitMatch } from "../matchService";

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
        [`msp-ch-${uid}@test.local`],
    );
    const { rows: opponentRows } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, email_normalized, password_hash, role)
         VALUES ($1, LOWER($1), 'test-hash', 'USER')
         RETURNING id`,
        [`msp-op-${uid}@test.local`],
    );
    const challengerId = challengerRows[0]!.id;
    const opponentId = opponentRows[0]!.id;

    // Disposable assets + pair. last_price is the force-close exit price
    // — setupCtx callers pass it in so each test can control the scenario.
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
    // match_id FK uses ON DELETE SET NULL; explicit deletes below.
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
    await pool.query(`DELETE FROM equity_snapshots WHERE user_id = $1 OR user_id = $2`, [ctx.challengerId, ctx.opponentId]);
    await pool.query(`DELETE FROM trading_pairs WHERE id = $1`, [ctx.pairId]);
    await pool.query(`DELETE FROM assets WHERE id = ANY($1)`, [[ctx.baseAssetId, ctx.quoteAssetId]]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[ctx.challengerId, ctx.opponentId]]);
}

describe("Match-scoped positions lifecycle", () => {
    describe("Test 1 — fill during match creates a match-scoped position", () => {
        let ctx: Ctx;
        beforeAll(async () => {
            ctx = await setupCtx("50000.00000000");
        });
        afterAll(async () => {
            await teardownCtx(ctx).catch(() => {});
        });

        it("applyFillToPositionTx with matchId creates a match-scoped row and no free-play row", async () => {
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

            const { rows: scoped } = await pool.query<{
                base_qty: string; avg_entry_price: string;
            }>(
                `SELECT base_qty::text, avg_entry_price::text
                 FROM positions
                 WHERE user_id = $1 AND pair_id = $2 AND match_id = $3`,
                [ctx.challengerId, ctx.pairId, ctx.matchId],
            );
            expect(scoped.length).toBe(1);
            expect(parseFloat(scoped[0]!.base_qty)).toBeCloseTo(0.1, 8);
            expect(parseFloat(scoped[0]!.avg_entry_price)).toBeCloseTo(50000, 2);

            // No free-play row should exist for same user+pair.
            const { rows: freePlay } = await pool.query(
                `SELECT 1 FROM positions
                 WHERE user_id = $1 AND pair_id = $2
                   AND match_id IS NULL AND competition_id IS NULL`,
                [ctx.challengerId, ctx.pairId],
            );
            expect(freePlay.length).toBe(0);
        });
    });

    describe("Test 2 — completeMatch closes the position and books profit", () => {
        let ctx: Ctx;
        beforeAll(async () => {
            // Position opened at 50000; last_price set to 52000 so close
            // books +$200 profit (0.1 * 2000).
            ctx = await setupCtx("52000.00000000");

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
        });
        afterAll(async () => {
            await teardownCtx(ctx).catch(() => {});
        });

        it("realizes +$200 PnL on completeMatch and winner/status are set", async () => {
            const match = await completeMatch(ctx.matchId);
            expect(match.status).toBe("COMPLETED");

            const { rows } = await pool.query<{
                base_qty: string; avg_entry_price: string; realized_pnl_quote: string;
            }>(
                `SELECT base_qty::text, avg_entry_price::text, realized_pnl_quote::text
                 FROM positions
                 WHERE user_id = $1 AND pair_id = $2 AND match_id = $3`,
                [ctx.challengerId, ctx.pairId, ctx.matchId],
            );
            expect(rows.length).toBe(1);
            expect(parseFloat(rows[0]!.base_qty)).toBeCloseTo(0, 8);
            expect(parseFloat(rows[0]!.avg_entry_price)).toBeCloseTo(0, 8);
            expect(parseFloat(rows[0]!.realized_pnl_quote)).toBeCloseTo(200, 2);

            expect(match.challenger_pnl_pct).not.toBeNull();
            expect(parseFloat(match.challenger_pnl_pct!)).toBeGreaterThan(0);
        });
    });

    describe("Test 3 — forfeitMatch closes positions, books loss, winner is non-forfeiter", () => {
        let ctx: Ctx;
        beforeAll(async () => {
            // Position opened at 50000; last_price set to 48000 so close
            // books -$200 loss (0.1 * (48000 - 50000)).
            ctx = await setupCtx("48000.00000000");

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
        });
        afterAll(async () => {
            await teardownCtx(ctx).catch(() => {});
        });

        it("challenger forfeits: position closes at -200 and loss hits challenger_pnl_pct (anti-gameability)", async () => {
            const match = await forfeitMatch(ctx.matchId, ctx.challengerId);
            expect(match.status).toBe("FORFEITED");
            expect(match.winner_id).toBe(ctx.opponentId);

            const { rows } = await pool.query<{
                base_qty: string; realized_pnl_quote: string;
            }>(
                `SELECT base_qty::text, realized_pnl_quote::text
                 FROM positions
                 WHERE user_id = $1 AND pair_id = $2 AND match_id = $3`,
                [ctx.challengerId, ctx.pairId, ctx.matchId],
            );
            expect(rows.length).toBe(1);
            expect(parseFloat(rows[0]!.base_qty)).toBeCloseTo(0, 8);
            expect(parseFloat(rows[0]!.realized_pnl_quote)).toBeCloseTo(-200, 2);

            // The anti-gameability requirement: the force-close loss must
            // land on match.challenger_pnl_pct. Starting capital = 50000,
            // loss = -200 → pnl_pct = -0.4%.
            expect(match.challenger_pnl_pct).not.toBeNull();
            expect(parseFloat(match.challenger_pnl_pct!)).toBeLessThan(0);
        });
    });
});
