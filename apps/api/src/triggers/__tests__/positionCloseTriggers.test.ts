/**
 * positionCloseTriggers.test.ts — TP/SL/trailing triggers never outlive the
 * position they protect, and never open or flip one.
 *
 * Regression for the 2026-10-11 QA P0: closing a short left its BUY TP and SL
 * ACTIVE and invisible; either could later fire a market order against no
 * position. Also: editing TP via the UI broke the OCO link (cancel+create).
 *
 * Real Postgres; real placeOrderWithSnapshot, matching engine, trigger engine
 * and match completion. Only push notifications are stubbed.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

vi.mock("../../notifications/notificationService", () => ({
    notifyTriggerFired: vi.fn().mockResolvedValue(undefined),
}));

import { randomUUID } from "node:crypto";
import { pool } from "../../db/pool";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets, fundTestMatchWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { placeOrderWithSnapshot } from "../../trading/phase6OrderService";
import { createTriggerOrder, updateTriggerByUser } from "../triggerRepo";
import { fireTrigger } from "../triggerEngine";
import { completeMatch, forfeitMatch, mutualForfeitMatch, cancelActiveMatch } from "../../competitions/matchService";
import type { TriggerKind } from "../triggerTypes";

let userId: string;
let pairId: string;
let btcAssetId: string;
let usdAssetId: string;

const PRICE = "50000";

async function trader() {
    const u = await createTestUser(pool);
    await createTestWallets(pool, u.id, btcAssetId, usdAssetId, "0.00000000", "100000.00000000");
    return u.id;
}

const market = (uid: string, side: "BUY" | "SELL", qty: string) =>
    placeOrderWithSnapshot(uid, { pairId, side, type: "MARKET", qty });

function trigger(side: "BUY" | "SELL", kind: TriggerKind, triggerPrice: string, qty = "0.01000000", extra: Partial<{ ocoGroupId: string; trailingOffset: string; trailingHighWaterMark: string; matchId: string | null }> = {}) {
    return createTriggerOrder({ userId, pairId, kind, side, triggerPrice, qty, matchId: null, ...extra });
}

/** An ACTIVE 1v1 between the test user and a fresh opponent. */
async function activeMatch(): Promise<string> {
    const opponent = await trader();
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status, started_at, ends_at)
         VALUES ($1, $2, 24, '50000', 'ACTIVE', now() - interval '1 hour', now() + interval '23 hours') RETURNING id`,
        [userId, opponent],
    );
    await fundTestMatchWallets(pool, rows[0].id, [userId, opponent]);
    return rows[0].id;
}

/** Market order in a match's scope (as the HTTP edge would route it). */
const matchMarket = (matchId: string, side: "BUY" | "SELL", qty: string) =>
    placeOrderWithSnapshot(userId, { pairId, side, type: "MARKET", qty }, undefined, undefined, null, matchId);

async function matchQty(matchId: string) {
    const { rows } = await pool.query<{ base_qty: string }>(
        `SELECT base_qty::text FROM positions WHERE user_id = $1 AND pair_id = $2 AND match_id = $3`,
        [userId, pairId, matchId],
    );
    return rows[0]?.base_qty ?? "0";
}

async function stateOf(id: string) {
    const { rows } = await pool.query<{ status: string; fail_reason: string | null; derived_order_id: string | null; oco_group_id: string | null; trigger_price: string; trailing_offset: string | null }>(
        `SELECT status, fail_reason, derived_order_id, oco_group_id, trigger_price::text, trailing_offset::text FROM trigger_orders WHERE id = $1`,
        [id],
    );
    return rows[0];
}

/** Free-play position (null competition/match) for the test user. */
async function freePlayQty(uid = userId) {
    const { rows } = await pool.query<{ base_qty: string }>(
        `SELECT base_qty::text FROM positions WHERE user_id = $1 AND pair_id = $2 AND competition_id IS NULL AND match_id IS NULL`,
        [uid, pairId],
    );
    return rows[0]?.base_qty ?? "0";
}

async function orderCount(uid = userId) {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM orders WHERE user_id = $1`, [uid]);
    return Number(rows[0].n);
}

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    await resetTestData();
    clearReferenceBooks();
    const assets = await createTestAssetAndPair(pool);
    pairId = assets.pair.id;
    btcAssetId = assets.btcAsset.id;
    usdAssetId = assets.usdAsset.id;
    userId = await trader();
    seedReferenceBook(pairId, PRICE, PRICE);
});

describe("closing a position cancels its triggers", () => {
    it("manual close of a SHORT cancels its BUY TP/SL (the QA repro) and a trailing stop", async () => {
        await market(userId, "SELL", "0.01000000");
        const oco = randomUUID();
        const sl = await trigger("BUY", "STOP_MARKET", "52000", undefined, { ocoGroupId: oco });
        const tp = await trigger("BUY", "TAKE_PROFIT_MARKET", "48000", undefined, { ocoGroupId: oco });
        const tsl = await trigger("BUY", "TRAILING_STOP_MARKET", "50500", undefined, { trailingOffset: "500", trailingHighWaterMark: "50000" });

        await market(userId, "BUY", "0.01000000"); // CLOSE POSITION

        for (const t of [sl, tp, tsl]) {
            expect(await stateOf(t.id)).toMatchObject({ status: "CANCELED", fail_reason: "position_closed" });
        }
    });

    it("a TP fire closes the long; the OCO SL and a standalone trailing stop are canceled", async () => {
        await market(userId, "BUY", "0.01000000");
        const oco = randomUUID();
        const tp = await trigger("SELL", "TAKE_PROFIT_MARKET", "51000", undefined, { ocoGroupId: oco });
        const sl = await trigger("SELL", "STOP_MARKET", "49000", undefined, { ocoGroupId: oco });
        const tsl = await trigger("SELL", "TRAILING_STOP_MARKET", "49500", undefined, { trailingOffset: "500", trailingHighWaterMark: "50000" });

        await fireTrigger(tp, { last: "51000" });

        expect((await stateOf(tp.id)).status).toBe("TRIGGERED");
        expect((await stateOf(sl.id)).status).toBe("CANCELED"); // OCO sibling
        expect(await stateOf(tsl.id)).toMatchObject({ status: "CANCELED", fail_reason: "position_closed" });
        expect(await freePlayQty()).toBe("0.00000000");
    });

    it("an SL fire cancels a standalone TP", async () => {
        await market(userId, "BUY", "0.01000000");
        const sl = await trigger("SELL", "STOP_MARKET", "49000");
        const tp = await trigger("SELL", "TAKE_PROFIT_MARKET", "51000");

        await fireTrigger(sl, { last: "49000" });

        expect((await stateOf(sl.id)).status).toBe("TRIGGERED");
        expect(await stateOf(tp.id)).toMatchObject({ status: "CANCELED", fail_reason: "position_closed" });
    });

    it("a trailing-stop fire cancels the TP and SL", async () => {
        await market(userId, "BUY", "0.01000000");
        const tsl = await trigger("SELL", "TRAILING_STOP_MARKET", "49500", undefined, { trailingOffset: "500", trailingHighWaterMark: "50000" });
        const oco = randomUUID();
        const tp = await trigger("SELL", "TAKE_PROFIT_MARKET", "51000", undefined, { ocoGroupId: oco });
        const sl = await trigger("SELL", "STOP_MARKET", "49000", undefined, { ocoGroupId: oco });

        await fireTrigger(tsl, { last: "49500" });

        expect((await stateOf(tsl.id)).status).toBe("TRIGGERED");
        expect((await stateOf(tp.id)).status).toBe("CANCELED");
        expect((await stateOf(sl.id)).status).toBe("CANCELED");
    });

    it("the maker side counts: a resting SELL limit that closes the long cancels its stop", async () => {
        await market(userId, "BUY", "0.01000000");
        const sl = await trigger("SELL", "STOP_MARKET", "49000");
        await placeOrderWithSnapshot(userId, { pairId, side: "SELL", type: "LIMIT", qty: "0.01000000", limitPrice: PRICE });
        expect((await stateOf(sl.id)).status).toBe("ACTIVE"); // still open while the limit rests

        const counterparty = await trader();
        await market(counterparty, "BUY", "0.01000000"); // hits the user's resting SELL

        expect(await freePlayQty()).toBe("0.00000000");
        expect(await stateOf(sl.id)).toMatchObject({ status: "CANCELED", fail_reason: "position_closed" });
    });

    it("flipping long → short cancels the long's SELL triggers", async () => {
        await market(userId, "BUY", "0.01000000");
        const sl = await trigger("SELL", "STOP_MARKET", "49000");

        await market(userId, "SELL", "0.02000000");

        expect(await freePlayQty()).toBe("-0.01000000");
        expect(await stateOf(sl.id)).toMatchObject({ status: "CANCELED", fail_reason: "position_closed" });
    });

    it("a partial close leaves the triggers active", async () => {
        await market(userId, "BUY", "0.02000000");
        const sl = await trigger("SELL", "STOP_MARKET", "49000", "0.02000000");

        await market(userId, "SELL", "0.01000000");

        expect((await stateOf(sl.id)).status).toBe("ACTIVE");
    });

    it("closing a long leaves BUY triggers alone (they don't protect it)", async () => {
        await market(userId, "BUY", "0.01000000");
        const buyStop = await trigger("BUY", "STOP_MARKET", "52000");

        await market(userId, "SELL", "0.01000000");

        expect((await stateOf(buyStop.id)).status).toBe("ACTIVE");
    });

    it("closing a free-play long cancels only free-play triggers; the match stop stays", async () => {
        const matchId = await activeMatch();
        await market(userId, "BUY", "0.01000000");          // free-play long
        await matchMarket(matchId, "BUY", "0.01000000");    // match long
        const freeSl = await trigger("SELL", "STOP_MARKET", "49000");
        const matchSl = await trigger("SELL", "STOP_MARKET", "49000", undefined, { matchId });

        await market(userId, "SELL", "0.01000000");         // close the free-play long

        expect(await stateOf(freeSl.id)).toMatchObject({ status: "CANCELED", fail_reason: "position_closed" });
        expect((await stateOf(matchSl.id)).status).toBe("ACTIVE");
    });

    it("closing a match long cancels only that match's triggers; the free-play stop stays", async () => {
        const matchId = await activeMatch();
        await market(userId, "BUY", "0.01000000");
        await matchMarket(matchId, "BUY", "0.01000000");
        const freeSl = await trigger("SELL", "STOP_MARKET", "49000");
        const matchSl = await trigger("SELL", "STOP_MARKET", "49000", undefined, { matchId });

        await matchMarket(matchId, "SELL", "0.01000000");   // close the match long

        expect(await stateOf(matchSl.id)).toMatchObject({ status: "CANCELED", fail_reason: "position_closed" });
        expect((await stateOf(freeSl.id)).status).toBe("ACTIVE");
    });
});

describe("a match ending cancels that match's triggers", () => {
    it("completeMatch: the match's triggers → match_ended; free-play triggers stay ACTIVE", async () => {
        const matchId = await activeMatch();
        await market(userId, "BUY", "0.01000000");
        await matchMarket(matchId, "BUY", "0.01000000");
        const freeSl = await trigger("SELL", "STOP_MARKET", "49000");
        const oco = randomUUID();
        const matchSl = await trigger("SELL", "STOP_MARKET", "49000", undefined, { matchId, ocoGroupId: oco });
        const matchTp = await trigger("SELL", "TAKE_PROFIT_MARKET", "51000", undefined, { matchId, ocoGroupId: oco });
        const matchBuyStop = await trigger("BUY", "STOP_MARKET", "52000", undefined, { matchId }); // not reducing the long

        await completeMatch(matchId);

        for (const t of [matchSl, matchTp, matchBuyStop]) {
            expect(await stateOf(t.id)).toMatchObject({ status: "CANCELED", fail_reason: "match_ended" });
        }
        expect((await stateOf(freeSl.id)).status).toBe("ACTIVE");
        expect(await freePlayQty()).toBe("0.01000000");
    });

    it("forfeit, mutual forfeit and cancel all cancel the match's triggers", async () => {
        const forfeited = await activeMatch();
        const fSl = await trigger("SELL", "STOP_MARKET", "49000", undefined, { matchId: forfeited });
        await forfeitMatch(forfeited, userId);
        expect(await stateOf(fSl.id)).toMatchObject({ status: "CANCELED", fail_reason: "match_ended" });

        const noShow = await activeMatch();
        const nSl = await trigger("SELL", "STOP_MARKET", "49000", undefined, { matchId: noShow });
        await mutualForfeitMatch(noShow);
        expect(await stateOf(nSl.id)).toMatchObject({ status: "CANCELED", fail_reason: "match_ended" });

        const canceled = await activeMatch();
        const cSl = await trigger("SELL", "STOP_MARKET", "49000", undefined, { matchId: canceled });
        await cancelActiveMatch(userId);
        expect(await stateOf(cSl.id)).toMatchObject({ status: "CANCELED", fail_reason: "match_ended" });
    });
});

describe("triggers are reduce-only at fire time", () => {
    it("partial close, then TP fires → closes only the remainder, never flips", async () => {
        await market(userId, "BUY", "0.02000000");
        const tp = await trigger("SELL", "TAKE_PROFIT_MARKET", "51000", "0.02000000");
        await market(userId, "SELL", "0.01000000"); // partial manual close

        await fireTrigger(tp, { last: "51000" });

        const fired = await stateOf(tp.id);
        expect(fired.status).toBe("TRIGGERED");
        const { rows } = await pool.query<{ qty: string }>(`SELECT qty::text FROM orders WHERE id = $1`, [fired.derived_order_id]);
        expect(rows[0].qty).toBe("0.01000000");
        expect(await freePlayQty()).toBe("0.00000000"); // flat, not short
    });

    it("full close, then a stale trigger fires → canceled (no_position), no order placed", async () => {
        await market(userId, "BUY", "0.01000000");
        await market(userId, "SELL", "0.01000000");
        // An orphan left over from before this fix (or any stale ACTIVE row).
        const oco = randomUUID();
        const stale = await trigger("SELL", "STOP_MARKET", "49000", undefined, { ocoGroupId: oco });
        const sibling = await trigger("SELL", "TAKE_PROFIT_MARKET", "51000", undefined, { ocoGroupId: oco });
        const ordersBefore = await orderCount();

        await fireTrigger(stale, { last: "49000" });

        expect(await stateOf(stale.id)).toMatchObject({ status: "CANCELED", fail_reason: "no_position", derived_order_id: null });
        expect((await stateOf(sibling.id)).status).toBe("CANCELED");
        expect(await orderCount()).toBe(ordersBefore);
        expect(await freePlayQty()).toBe("0.00000000");
    });

    it("clamps to the wallet the order lands in, not the total: a match long never lets a stale stop short free-play", async () => {
        // Long 0.1 BTC in a match wallet; flat in free-play. The user is not in
        // an ACTIVE match, so the stop's derived order would land in free-play.
        const opponent = await trader();
        const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status, started_at, ends_at)
             VALUES ($1, $2, 24, '50000', 'COMPLETED', now() - interval '25 hours', now() - interval '1 hour') RETURNING id`,
            [userId, opponent],
        );
        await pool.query(
            `INSERT INTO positions (user_id, pair_id, match_id, base_qty, avg_entry_price) VALUES ($1, $2, $3, '0.10000000', '50000')`,
            [userId, pairId, rows[0].id],
        );
        const stale = await trigger("SELL", "STOP_MARKET", "49000", "0.10000000");
        const ordersBefore = await orderCount();

        await fireTrigger(stale, { last: "49000" });

        expect(await stateOf(stale.id)).toMatchObject({ status: "CANCELED", fail_reason: "no_position", derived_order_id: null });
        expect(await orderCount()).toBe(ordersBefore);
        expect(await freePlayQty()).toBe("0"); // no free-play position row at all — never sold into a short
        const { rows: mp } = await pool.query<{ base_qty: string }>(
            `SELECT base_qty::text FROM positions WHERE user_id = $1 AND match_id = $2`, [userId, rows[0].id],
        );
        expect(mp[0].base_qty).toBe("0.10000000"); // match position untouched
    });

    it("a stop on a short only buys back the short", async () => {
        await market(userId, "SELL", "0.01000000");
        const sl = await trigger("BUY", "STOP_MARKET", "51000", "0.05000000"); // oversized

        await fireTrigger(sl, { last: "51000" });

        expect(await freePlayQty()).toBe("0.00000000");
    });
});

describe("a trigger acts on the account it was created in", () => {
    // A free-play SELL stop, then the user joins a match and goes long there.
    // The stop protects the FREE-PLAY long it was created for. Before 094 the
    // scope was resolved at fire time (getActiveMatchIdForUser), so it sold the
    // match long instead.
    it("a free-play stop closes the free-play long, not a later match long", async () => {
        await market(userId, "BUY", "0.01000000"); // free-play long
        const sl = await trigger("SELL", "STOP_MARKET", "49000", "0.01000000");

        const matchId = await activeMatch();
        await matchMarket(matchId, "BUY", "0.01000000");
        expect(await matchQty(matchId)).toBe("0.01000000");

        await fireTrigger(sl, { last: "49000" });

        expect(await matchQty(matchId)).toBe("0.01000000");  // match long untouched
        expect(await freePlayQty()).toBe("0.00000000");      // free-play long closed
    });

    it("a match stop closes the match long, never a free-play long", async () => {
        const matchId = await activeMatch();
        await market(userId, "BUY", "0.01000000");
        await matchMarket(matchId, "BUY", "0.01000000");
        const sl = await trigger("SELL", "STOP_MARKET", "49000", "0.01000000", { matchId });

        await fireTrigger(sl, { last: "49000" });

        expect(await matchQty(matchId)).toBe("0.00000000");
        expect(await freePlayQty()).toBe("0.01000000");
    });

    it("a match stop firing after its match ended → canceled (match_ended), no order", async () => {
        const matchId = await activeMatch();
        await market(userId, "BUY", "0.01000000"); // a free-play long it must not touch
        await matchMarket(matchId, "BUY", "0.01000000");
        const oco = randomUUID();
        const sl = await trigger("SELL", "STOP_MARKET", "49000", "0.01000000", { matchId, ocoGroupId: oco });
        const tp = await trigger("SELL", "TAKE_PROFIT_MARKET", "51000", "0.01000000", { matchId, ocoGroupId: oco });
        // The match ended without its triggers being swept (e.g. a row that
        // slipped past the match-end cancel) — fireTrigger is the backstop.
        await pool.query(`UPDATE matches SET status = 'COMPLETED', completed_at = now() WHERE id = $1`, [matchId]);
        const ordersBefore = await orderCount();

        await fireTrigger(sl, { last: "49000" });

        expect(await stateOf(sl.id)).toMatchObject({ status: "CANCELED", fail_reason: "match_ended", derived_order_id: null });
        expect((await stateOf(tp.id)).status).toBe("CANCELED");
        expect(await orderCount()).toBe(ordersBefore);
        expect(await freePlayQty()).toBe("0.01000000");
        expect(await matchQty(matchId)).toBe("0.01000000");
    });
});

describe("editing a trigger keeps the OCO link", () => {
    it("PATCHing the TP price keeps id + oco_group_id; the SL fire still cancels it", async () => {
        await market(userId, "BUY", "0.01000000");
        const oco = randomUUID();
        const tp = await trigger("SELL", "TAKE_PROFIT_MARKET", "51000", undefined, { ocoGroupId: oco });
        const sl = await trigger("SELL", "STOP_MARKET", "49000", undefined, { ocoGroupId: oco });

        const edited = await updateTriggerByUser(userId, tp.id, { triggerPrice: "51500" });
        expect(edited).toMatchObject({ id: tp.id, oco_group_id: oco, trigger_price: "51500.00000000", status: "ACTIVE" });

        await fireTrigger(sl, { last: "49000" });
        expect((await stateOf(tp.id)).status).toBe("CANCELED");
    });

    it("editing a trailing stop's offset re-derives its stop from the high-water mark", async () => {
        const tsl = await trigger("SELL", "TRAILING_STOP_MARKET", "49500", undefined, { trailingOffset: "500", trailingHighWaterMark: "50200" });
        const edited = await updateTriggerByUser(userId, tsl.id, { trailingOffset: "300" });
        expect(edited).toMatchObject({ trailing_offset: "300.00000000", trigger_price: "49900.00000000" });
    });

    it("rejects the wrong field, another user's trigger, and a non-active trigger", async () => {
        const tp = await trigger("SELL", "TAKE_PROFIT_MARKET", "51000");
        await expect(updateTriggerByUser(userId, tp.id, { trailingOffset: "100" })).rejects.toThrow("invalid_input");

        const other = await trader();
        await expect(updateTriggerByUser(other, tp.id, { triggerPrice: "52000" })).rejects.toThrow("trigger_not_found");

        await pool.query(`UPDATE trigger_orders SET status = 'CANCELED' WHERE id = $1`, [tp.id]);
        await expect(updateTriggerByUser(userId, tp.id, { triggerPrice: "52000" })).rejects.toThrow("trigger_not_editable");
    });
});
