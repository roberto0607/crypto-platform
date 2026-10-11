/**
 * cancelOrphans.test.ts — the one-time orphaned-trigger cleanup
 * (triggers/cancelOrphans.ts) against the real test DB: what counts as an
 * orphan, the atomic re-check at commit, and an exact revert.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { pool } from "../../db/pool";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair } from "../../testing/fixtures";
import { createTriggerOrder } from "../triggerRepo";
import { planOrphanCleanup, applyOrphanCleanup, revertOrphanCleanup, distancePct, ORPHAN_CLEANUP_REASON } from "../cancelOrphans";

let pairId: string;
let alice: string;
let bob: string;

const stop = (userId: string, side: "BUY" | "SELL", price = side === "SELL" ? "49000" : "51000") =>
    createTriggerOrder({ userId, pairId, kind: "STOP_MARKET", side, triggerPrice: price, qty: "0.01000000" });

async function position(userId: string, qty: string, matchId: string | null = null) {
    await pool.query(
        `INSERT INTO positions (user_id, pair_id, match_id, base_qty, avg_entry_price) VALUES ($1, $2, $3, $4, '50000')`,
        [userId, pairId, matchId, qty],
    );
}

async function statusOf(id: string) {
    const { rows } = await pool.query<{ status: string; fail_reason: string | null }>(
        `SELECT status, fail_reason FROM trigger_orders WHERE id = $1`, [id],
    );
    return rows[0];
}

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    await resetTestData();
    pairId = (await createTestAssetAndPair(pool)).pair.id;
    alice = (await createTestUser(pool)).id;
    bob = (await createTestUser(pool)).id;
});

describe("planOrphanCleanup", () => {
    it("flags triggers with nothing to reduce, and only those", async () => {
        // alice: flat → both her triggers are orphans
        const aliceSell = await stop(alice, "SELL");
        const aliceBuy = await stop(alice, "BUY");
        // bob: long → his SELL stop protects it (keep); his BUY stop has no short (orphan)
        await position(bob, "0.01000000");
        const bobSell = await stop(bob, "SELL");
        const bobBuy = await stop(bob, "BUY");
        // canceled/triggered rows are never candidates
        const done = await stop(alice, "SELL");
        await pool.query(`UPDATE trigger_orders SET status = 'TRIGGERED' WHERE id = $1`, [done.id]);

        const ids = (await planOrphanCleanup()).map((o) => o.id).sort();
        expect(ids).toEqual([aliceSell.id, aliceBuy.id, bobBuy.id].sort());
        expect(ids).not.toContain(bobSell.id);
    });

    it("a position in ANY scope (e.g. a match) keeps the trigger", async () => {
        const opponent = (await createTestUser(pool)).id;
        const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status, started_at, ends_at)
             VALUES ($1, $2, 24, '50000', 'ACTIVE', now(), now() + interval '1 day') RETURNING id`,
            [alice, opponent],
        );
        await position(alice, "-0.01000000", rows[0].id); // match-scoped short
        const buyStop = await stop(alice, "BUY");
        expect((await planOrphanCleanup()).map((o) => o.id)).not.toContain(buyStop.id);
    });

    it("--user filters to one user", async () => {
        await stop(alice, "SELL");
        const bobs = await stop(bob, "SELL");
        expect((await planOrphanCleanup({ userId: bob })).map((o) => o.id)).toEqual([bobs.id]);
    });

    it("reports distance from the last price", () => {
        expect(distancePct({ trigger_price: "49000", last_price: "50000" })).toBeCloseTo(-2, 8);
        expect(distancePct({ trigger_price: "49000", last_price: null })).toBeNull();
    });
});

describe("applyOrphanCleanup + revertOrphanCleanup", () => {
    it("cancels with the marker, re-checks atomically, and reverts exactly", async () => {
        const a = await stop(alice, "SELL");
        const b = await stop(bob, "SELL");
        const plan = await planOrphanCleanup();
        expect(plan.map((o) => o.id).sort()).toEqual([a.id, b.id].sort());

        // bob opens a long between the dry run and --commit → his stop is no longer an orphan
        await position(bob, "0.01000000");

        const canceled = await applyOrphanCleanup(plan.map((o) => o.id));
        expect(canceled.map((o) => o.id)).toEqual([a.id]);
        expect(canceled[0]).toMatchObject({ kind: "STOP_MARKET", side: "SELL", trigger_price: "49000.00000000" });
        expect(await statusOf(a.id)).toEqual({ status: "CANCELED", fail_reason: ORPHAN_CLEANUP_REASON });
        expect(await statusOf(b.id)).toEqual({ status: "ACTIVE", fail_reason: null });

        // A trigger canceled for another reason is never touched by revert.
        const userCanceled = await stop(alice, "BUY");
        await pool.query(`UPDATE trigger_orders SET status = 'CANCELED' WHERE id = $1`, [userCanceled.id]);

        const restored = await revertOrphanCleanup([a.id, userCanceled.id]);
        expect(restored).toEqual([a.id]);
        expect(await statusOf(a.id)).toEqual({ status: "ACTIVE", fail_reason: null });
        expect((await statusOf(userCanceled.id)).status).toBe("CANCELED");
    });
});
