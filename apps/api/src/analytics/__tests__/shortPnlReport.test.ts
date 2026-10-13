/**
 * shortPnlReport.test.ts — the read-only short P&L report: the pure
 * comparison (positions + ended matches) and the loaders against the
 * *_test database.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { pool } from "../../db/pool";
import { resetTestData } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair } from "../../testing/fixtures";
import {
    replayScopes,
    comparePositions,
    compareMatches,
    totalDelta,
    loadScopeFills,
    loadStoredPositions,
    type ScopeFill,
    type StoredPosition,
    type ReportMatch,
} from "../shortPnlReport";

const U1 = "00000000-0000-0000-0000-0000000000a1";
const U2 = "00000000-0000-0000-0000-0000000000a2";
const P = "00000000-0000-0000-0000-0000000000b1";
const M = "00000000-0000-0000-0000-0000000000c1";

function fill(user: string, side: "BUY" | "SELL", qty: string, price: string, match: string | null = null): ScopeFill {
    return { user_id: user, pair_id: P, competition_id: null, match_id: match, side, qty, price };
}

function stored(user: string, qty: string, entry: string, realized: string, match: string | null = null, fees = "0"): StoredPosition {
    return {
        user_id: user, pair_id: P, competition_id: null, match_id: match,
        base_qty: qty, avg_entry_price: entry, realized_pnl_quote: realized, fees_paid_quote: fees,
    };
}

describe("comparePositions", () => {
    it("reports a covered short's missing realized P&L (short 2 @ 110, buy 1 @ 90)", () => {
        const fills = [fill(U1, "SELL", "2", "110"), fill(U1, "BUY", "1", "90")];
        // What the old math stored: qty right, entry 110, realized 0.
        const findings = comparePositions([stored(U1, "-1", "110", "0")], replayScopes(fills));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            stored_realized: "0.00000000",
            correct_realized: "20.00000000",
            delta_realized: "20.00000000",
            stored_entry: "110.00000000",
            correct_entry: "110.00000000",
            reliable: true,
            fills: 2,
        });
    });

    it("reports an open short's wrong entry after an add", () => {
        const fills = [fill(U1, "SELL", "1", "100"), fill(U1, "SELL", "1", "120")];
        const findings = comparePositions([stored(U1, "-2", "120", "0")], replayScopes(fills));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ delta_realized: "0.00000000", stored_entry: "120.00000000", correct_entry: "110.00000000" });
    });

    it("skips a row that already agrees (longs)", () => {
        const fills = [fill(U1, "BUY", "1", "100"), fill(U1, "SELL", "1", "130")];
        expect(comparePositions([stored(U1, "0", "0", "30")], replayScopes(fills))).toEqual([]);
    });

    it("skips a row with no fills", () => {
        expect(comparePositions([stored(U1, "0", "0", "5")], replayScopes([]))).toEqual([]);
    });

    it("flags a row whose replayed qty differs as unreliable and leaves it out of the total", () => {
        const fills = [
            fill(U1, "SELL", "2", "110"), fill(U1, "BUY", "1", "90"),            // reliable: Δ +20
            fill(U2, "SELL", "1", "100"), fill(U2, "BUY", "1", "50"),            // replays flat…
        ];
        const findings = comparePositions(
            [stored(U1, "-1", "110", "0"), stored(U2, "-3", "100", "0")],        // …but stored says -3
            replayScopes(fills),
        );

        expect(findings.map((f) => [f.user_id, f.reliable])).toEqual([[U1, true], [U2, false]]);
        expect(totalDelta(findings)).toBe("20.00000000");
    });

    it("keeps scopes apart: a match short doesn't mix with a free-play long", () => {
        const fills = [
            fill(U1, "BUY", "1", "100"),
            fill(U1, "SELL", "1", "110", M), fill(U1, "BUY", "1", "100", M),
        ];
        const findings = comparePositions(
            [stored(U1, "1", "100", "0"), stored(U1, "0", "110", "0", M)],
            replayScopes(fills),
        );

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ match_id: M, correct_realized: "10.00000000" });
    });
});

describe("compareMatches", () => {
    function match(status: string, winner: string | null): ReportMatch {
        return {
            id: M, status, completed_at: "2026-10-01T00:00:00Z", starting_capital: "1000",
            challenger_id: U1, opponent_id: U2,
            challenger_pnl_pct: "0.0000", opponent_pnl_pct: "1.0000",
            challenger_trades_count: 2, opponent_trades_count: 2,
            challenger_score: "40.6000", opponent_score: "65.6000",
            winner_id: winner,
        };
    }

    // Challenger covered a short for +$20 (stored as 0); opponent made +$10 on a long.
    const fills = [
        fill(U1, "SELL", "2", "110", M), fill(U1, "BUY", "2", "100", M),
        fill(U2, "BUY", "1", "100", M), fill(U2, "SELL", "1", "110", M),
    ];
    const rows = [stored(U1, "0", "110", "0", M), stored(U2, "0", "0", "10", M)];

    it("recomputes P&L% and score and reports a winner that would change", () => {
        const findings = comparePositions(rows, replayScopes(fills));
        const [m] = compareMatches([match("COMPLETED", U2)], rows, findings);

        expect(m.challenger).toMatchObject({ stored_pnl_pct: "0.0000", correct_pnl_pct: "2.0000" });
        expect(m.opponent).toMatchObject({ correct_pnl_pct: "1.0000" });
        expect(Number(m.challenger.correct_score)).toBeGreaterThan(Number(m.opponent.correct_score));
        expect(m.correct_winner_id).toBe(U1);
        expect(m.winner_changes).toBe(true);
        expect(m.reliable).toBe(true);
    });

    it("keeps a forfeit's winner (set by the rule, not the score)", () => {
        const findings = comparePositions(rows, replayScopes(fills));
        const [m] = compareMatches([match("FORFEITED", U2)], rows, findings);

        expect(m.correct_winner_id).toBe(U2);
        expect(m.winner_changes).toBe(false);
    });

    it("skips a match none of whose rows is affected", () => {
        const longOnly = [fill(U2, "BUY", "1", "100", M), fill(U2, "SELL", "1", "110", M)];
        const okRows = [stored(U2, "0", "0", "10", M)];
        expect(compareMatches([match("COMPLETED", U2)], okRows, comparePositions(okRows, replayScopes(longOnly)))).toEqual([]);
    });
});

describe("loaders (read-only queries)", () => {
    let userId: string;
    let pairId: string;

    beforeEach(async () => {
        await resetTestData();
        userId = (await createTestUser(pool)).id;
        pairId = (await createTestAssetAndPair(pool)).pair.id;
    });

    afterAll(async () => {
        await pool.end();
    });

    async function order(side: "BUY" | "SELL", matchId: string | null): Promise<string> {
        const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO orders (user_id, pair_id, side, type, qty, qty_filled, status, match_id)
             VALUES ($1, $2, $3, 'MARKET', 1, 1, 'FILLED', $4) RETURNING id`,
            [userId, pairId, side, matchId],
        );
        return rows[0].id;
    }

    async function trade(side: "BUY" | "SELL", qty: string, price: string, at: string, matchId: string | null = null) {
        const orderId = await order(side, matchId);
        await pool.query(
            `INSERT INTO trades (pair_id, buy_order_id, sell_order_id, price, qty, quote_amount, is_system_fill, executed_at)
             VALUES ($1, $2, $3, $4, $5, $4::numeric * $5::numeric, true, $6)`,
            [pairId, side === "BUY" ? orderId : null, side === "SELL" ? orderId : null, price, qty, at],
        );
    }

    it("returns each fill with its order's scope, in execution order, and finds the bug end to end", async () => {
        const opp = (await createTestUser(pool)).id;
        const { rows: m } = await pool.query<{ id: string }>(
            `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status)
             VALUES ($1, $2, 24, '1000', 'COMPLETED') RETURNING id`,
            [userId, opp],
        );
        const matchId = m[0].id;

        // Inserted out of order on purpose: the loader orders by executed_at.
        await trade("BUY", "1", "90", "2026-10-01T00:00:02Z");
        await trade("SELL", "2", "110", "2026-10-01T00:00:01Z");
        await trade("SELL", "1", "100", "2026-10-01T00:00:03Z", matchId);

        await pool.query(
            `INSERT INTO positions (user_id, pair_id, base_qty, avg_entry_price, realized_pnl_quote, fees_paid_quote, match_id)
             VALUES ($1, $2, -1, 110, 0, 0, NULL), ($1, $2, -1, 100, 0, 0, $3)`,
            [userId, pairId, matchId],
        );

        const fills = await loadScopeFills(pool, userId);
        expect(fills.map((f) => [f.side, f.match_id])).toEqual([["SELL", null], ["BUY", null], ["SELL", matchId]]);

        const findings = comparePositions(await loadStoredPositions(pool, userId), replayScopes(fills));
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ match_id: null, delta_realized: "20.00000000", reliable: true });
    });
});
