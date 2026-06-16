/**
 * matchEndPush.test.ts — regression guard for the match-end SSE push.
 *
 * Every terminal transition (forfeit, timer-expiry complete, mutual forfeit)
 * must publish a `match.ended` event to BOTH participants the instant the match
 * resolves — otherwise the opponent's WON/LOST screen lags until the next poll
 * tick (the bug this PR fixes). The eventBus delivers synchronously after the
 * handler's COMMIT, so we can assert without any waiting.
 *
 * Integration test — hits the real Postgres at DATABASE_URL. Mirrors the setup
 * harness in matchScopedPositions.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../../db/pool";
import { applyFillToPositionTx } from "../../analytics/positionRepo";
import { completeMatch, forfeitMatch, mutualForfeitMatch } from "../matchService";
import { subscribe, unsubscribe, type EventHandler } from "../../events/eventBus";
import type { AppEvent, MatchEndedData } from "../../events/eventTypes";

type Ctx = {
    challengerId: string;
    opponentId: string;
    baseAssetId: string;
    quoteAssetId: string;
    pairId: string;
    matchId: string;
};

async function setupCtx(lastPrice: string): Promise<Ctx> {
    const uid = Math.random().toString(36).slice(2, 7);

    const { rows: challengerRows } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, email_normalized, password_hash, role)
         VALUES ($1, LOWER($1), 'test-hash', 'USER') RETURNING id`,
        [`mep-ch-${uid}@test.local`],
    );
    const { rows: opponentRows } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, email_normalized, password_hash, role)
         VALUES ($1, LOWER($1), 'test-hash', 'USER') RETURNING id`,
        [`mep-op-${uid}@test.local`],
    );
    const challengerId = challengerRows[0]!.id;
    const opponentId = opponentRows[0]!.id;

    const { rows: baseRows } = await pool.query<{ id: string }>(
        `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $2, 8) RETURNING id`,
        [`B${uid.toUpperCase()}`, `BTC-${uid}`],
    );
    const { rows: quoteRows } = await pool.query<{ id: string }>(
        `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $2, 2) RETURNING id`,
        [`Q${uid.toUpperCase()}`, `USD-${uid}`],
    );
    const baseAssetId = baseRows[0]!.id;
    const quoteAssetId = quoteRows[0]!.id;

    const { rows: pairRows } = await pool.query<{ id: string }>(
        `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active, last_price, fee_bps)
         VALUES ($1, $2, $3, true, $4, 30) RETURNING id`,
        [baseAssetId, quoteAssetId, `P${uid.toUpperCase()}/USD`, lastPrice],
    );
    const pairId = pairRows[0]!.id;

    const { rows: matchRows } = await pool.query<{ id: string }>(
        `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status, started_at, ends_at)
         VALUES ($1, $2, 24, '50000', 'ACTIVE', now() - interval '1 hour', now() + interval '23 hours')
         RETURNING id`,
        [challengerId, opponentId],
    );
    const matchId = matchRows[0]!.id;

    return { challengerId, opponentId, baseAssetId, quoteAssetId, pairId, matchId };
}

async function openPosition(ctx: Ctx, userId: string): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await applyFillToPositionTx(client, {
            userId,
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
    await pool.query(`DELETE FROM equity_snapshots WHERE user_id = $1 OR user_id = $2`, [ctx.challengerId, ctx.opponentId]);
    await pool.query(`DELETE FROM trading_pairs WHERE id = $1`, [ctx.pairId]);
    await pool.query(`DELETE FROM assets WHERE id = ANY($1)`, [[ctx.baseAssetId, ctx.quoteAssetId]]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[ctx.challengerId, ctx.opponentId]]);
}

/** Capture `match.ended` events delivered to a specific user. */
function captureFor(userId: string): { ended: MatchEndedData[]; stop: () => void } {
    const ended: MatchEndedData[] = [];
    const handler: EventHandler = (e: AppEvent) => {
        if (e.type === "match.ended") ended.push(e.data);
    };
    subscribe(userId, handler);
    return { ended, stop: () => unsubscribe(handler) };
}

describe("match.ended push — both participants notified on every terminal transition", () => {
    it("forfeitMatch publishes to BOTH players with the correct verdict + elo deltas", async () => {
        const ctx = await setupCtx("48000.00000000"); // close books -$200 for challenger
        await openPosition(ctx, ctx.challengerId);
        const ch = captureFor(ctx.challengerId);
        const op = captureFor(ctx.opponentId);
        try {
            await forfeitMatch(ctx.matchId, ctx.challengerId);

            expect(ch.ended.length).toBe(1);
            expect(op.ended.length).toBe(1);
            const ev = ch.ended[0]!;
            // Both participants receive identical payload.
            expect(op.ended[0]).toEqual(ev);
            expect(ev.matchId).toBe(ctx.matchId);
            expect(ev.reason).toBe("forfeit");
            expect(ev.winnerUserId).toBe(ctx.opponentId);
            expect(ev.loserUserId).toBe(ctx.challengerId);
            expect(ev.forfeitUserId).toBe(ctx.challengerId);
            // Verdict carries the pnls (no client re-fetch needed for the result).
            expect(parseFloat(ev.challengerPnlPct!)).toBeLessThan(0);
            // ELO deltas present: winner gains, loser loses.
            expect(ev.eloDeltas).not.toBeNull();
            expect(ev.eloDeltas!.winner).toBeGreaterThan(0);
            expect(ev.eloDeltas!.loser).toBeLessThan(0);
        } finally {
            ch.stop();
            op.stop();
            await teardownCtx(ctx).catch(() => {});
        }
    });

    it("completeMatch (timer expiry) publishes reason='timeout' to BOTH players", async () => {
        const ctx = await setupCtx("52000.00000000"); // close books +$200 for challenger → challenger wins
        await openPosition(ctx, ctx.challengerId);
        const ch = captureFor(ctx.challengerId);
        const op = captureFor(ctx.opponentId);
        try {
            await completeMatch(ctx.matchId);

            expect(ch.ended.length).toBe(1);
            expect(op.ended.length).toBe(1);
            const ev = ch.ended[0]!;
            expect(op.ended[0]).toEqual(ev);
            expect(ev.matchId).toBe(ctx.matchId);
            expect(ev.reason).toBe("timeout");
            expect(ev.winnerUserId).toBe(ctx.challengerId);
            expect(ev.loserUserId).toBe(ctx.opponentId);
            expect(ev.forfeitUserId).toBeNull();
            expect(ev.eloDeltas).not.toBeNull();
            expect(ev.eloDeltas!.winner).toBeGreaterThan(0);
        } finally {
            ch.stop();
            op.stop();
            await teardownCtx(ctx).catch(() => {});
        }
    });

    it("mutualForfeitMatch (no-show) publishes reason='mutual_forfeit', no winner, to BOTH players", async () => {
        const ctx = await setupCtx("50000.00000000"); // zero fills — required for mutual forfeit
        const ch = captureFor(ctx.challengerId);
        const op = captureFor(ctx.opponentId);
        try {
            await mutualForfeitMatch(ctx.matchId);

            expect(ch.ended.length).toBe(1);
            expect(op.ended.length).toBe(1);
            const ev = ch.ended[0]!;
            expect(op.ended[0]).toEqual(ev);
            expect(ev.matchId).toBe(ctx.matchId);
            expect(ev.reason).toBe("mutual_forfeit");
            expect(ev.winnerUserId).toBeNull();
            expect(ev.loserUserId).toBeNull();
            expect(ev.forfeitUserId).toBeNull();
            expect(ev.eloDeltas).toBeNull();
        } finally {
            ch.stop();
            op.stop();
            await teardownCtx(ctx).catch(() => {});
        }
    });
});
