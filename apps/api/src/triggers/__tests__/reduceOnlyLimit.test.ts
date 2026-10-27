/**
 * reduceOnlyLimit.test.ts: TP/SL that place LIMIT orders are reduce-only
 * (leverage PR 7).
 *
 * STOP_LIMIT / TAKE_PROFIT_LIMIT fire a LIMIT order, which may rest. Before
 * PR 7 it wasn't reduce-only, so once its position was gone (a liquidation,
 * a manual close, the other leg) a resting one could still fill later and
 * open or flip a position. Now:
 *   - the derived LIMIT is reduce-only (orders.reduce_only): trimmed to the
 *     position under the pair lock, rejected when there's nothing to reduce;
 *   - a fill that closes the position cancels the user's resting reduce-only
 *     orders on that side, in the same transaction (position_closed);
 *   - when a resting one is swept, it fills at most what's left of the
 *     position; the rest is canceled (reduce_only_no_position);
 *   - an ISOLATED one reserves no margin (it can't open).
 *
 * Races (staged with the pair lock): TP limit vs liquidation and SL limit vs
 * the user's manual close, in both orders.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import type { PoolClient } from "pg";
import { pool } from "../../db/pool";
import { config } from "../../config";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { resetMarketDataPairIdCache } from "../../market/marketSymbols";
import { placeOrderWithSnapshot } from "../../trading/phase6OrderService";
import { createTriggerOrder } from "../triggerRepo";
import { fireTrigger } from "../triggerEngine";
import type { TriggerKind } from "../triggerTypes";

let pairId: string;
let btcAssetId: string;
let usdAssetId: string;
const saved = { ...config.leverage };

const flagOn = () => Object.assign(config.leverage, {
    enabled: true, liquidationMode: "execute", maxFreePlay: 10, maxMatch: 5, maxCompetition: 1, allowlist: [],
});

async function trader(usd = "10000.00000000"): Promise<string> {
    const u = await createTestUser(pool);
    await createTestWallets(pool, u.id, btcAssetId, usdAssetId, "0.00000000", usd);
    return u.id;
}

const market = (uid: string, side: "BUY" | "SELL", qty: string, opts: { leverage?: number; reduceOnly?: boolean } = {}) =>
    placeOrderWithSnapshot(uid, { pairId, side, type: "MARKET", qty, leverage: opts.leverage, reduceOnly: opts.reduceOnly });

const limit = (uid: string, side: "BUY" | "SELL", qty: string, limitPrice: string, leverage?: number) =>
    placeOrderWithSnapshot(uid, { pairId, side, type: "LIMIT", qty, limitPrice, leverage });

const liquidate = (uid: string, epoch: number, qty: string) =>
    placeOrderWithSnapshot(
        uid, { pairId, side: "SELL", type: "MARKET", qty },
        undefined, undefined, null, null, "liquidation", { epoch, side: "LONG" },
    );

async function position(uid: string) {
    const { rows } = await pool.query<{ base_qty: string; epoch: number }>(
        `SELECT base_qty::text, epoch FROM positions
         WHERE user_id = $1 AND pair_id = $2 AND competition_id IS NULL AND match_id IS NULL`,
        [uid, pairId]);
    return rows[0];
}

async function trigger(uid: string, kind: TriggerKind, triggerPrice: string, limitPrice: string, qty: string) {
    return createTriggerOrder({ userId: uid, pairId, kind, side: "SELL", triggerPrice, limitPrice, qty, matchId: null });
}

async function triggerRow(id: string) {
    const { rows: [t] } = await pool.query<{ status: string; fail_reason: string | null; derived_order_id: string | null }>(
        `SELECT status, fail_reason, derived_order_id FROM trigger_orders WHERE id = $1`, [id]);
    return t;
}

async function orderRow(id: string) {
    const { rows: [o] } = await pool.query<{
        status: string; qty: string; qty_filled: string; reduce_only: boolean; cancel_reason: string | null;
        reserved_amount: string; reserved_consumed: string;
    }>(
        `SELECT status, qty::text, qty_filled::text, reduce_only, cancel_reason,
                reserved_amount::text, reserved_consumed::text
         FROM orders WHERE id = $1`, [id]);
    return o;
}

/** Nothing held: every wallet's reserve is back to 0 (no open order is left holding funds). */
async function reservesReleased(uid: string): Promise<void> {
    const { rows } = await pool.query(`SELECT asset_id, reserved::text FROM wallets WHERE user_id = $1 AND reserved <> 0`, [uid]);
    expect(rows).toEqual([]);
}

async function holdPairLock(): Promise<() => Promise<void>> {
    const client: PoolClient = await pool.connect();
    await client.query("BEGIN");
    await client.query(`SELECT id FROM trading_pairs WHERE id = $1 FOR UPDATE`, [pairId]);
    return async () => {
        await client.query("COMMIT");
        client.release();
    };
}

async function waitBlocked(n: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
        if (Number(rows[0].n) >= n) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} blocked backends (have ${rows[0].n})`);
        await new Promise((r) => setTimeout(r, 20));
    }
}

async function noNegativeUsd(): Promise<void> {
    const { rows } = await pool.query(`SELECT user_id, balance::text FROM wallets WHERE asset_id = $1 AND balance < 0`, [usdAssetId]);
    expect(rows).toEqual([]);
}

/** Another user lifts the book at `price` (a MARKET BUY sweeps resting SELLs there). */
async function sweepAt(price: string, qty: string): Promise<void> {
    seedReferenceBook(pairId, price, price);
    const taker = await trader("100000.00000000");
    await market(taker, "BUY", qty);
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
    seedReferenceBook(pairId, "83000", "83000");
    resetMarketDataPairIdCache();
});

afterEach(() => {
    Object.assign(config.leverage, saved, { allowlist: [...saved.allowlist] });
});

describe.each([
    ["SPOT (flag off)", () => {}],
    ["ISOLATED (flag on, 10x)", flagOn],
])("a TP/SL limit order is reduce-only, %s", (_label, setup) => {
    beforeEach(() => setup());
    const lev = () => (config.leverage.enabled ? 10 : undefined);
    const QTY = "0.01000000";

    async function restingTp(u: string, qty = QTY) {
        const tp = await trigger(u, "TAKE_PROFIT_LIMIT", "84000", "90000", qty);
        await fireTrigger(tp, { last: "84000" });
        const t = await triggerRow(tp.id);
        expect(t.status).toBe("TRIGGERED");
        return t.derived_order_id!;
    }

    it("the derived LIMIT rests as reduce-only, trimmed to the position", async () => {
        const u = await trader();
        await market(u, "BUY", QTY, { leverage: lev() });
        const id = await restingTp(u, "0.05000000");
        const o = await orderRow(id);
        expect(o).toMatchObject({ status: "OPEN", qty: QTY, reduce_only: true });
        if (config.leverage.enabled) expect(o.reserved_amount).toBe("0.00000000"); // can't open: no margin held
    });

    it("a manual close cancels the resting TP order in the same transaction; a later sweep can't open anything", async () => {
        const u = await trader();
        await market(u, "BUY", QTY, { leverage: lev() });
        const id = await restingTp(u);
        await market(u, "SELL", QTY, { reduceOnly: true });
        expect(await orderRow(id)).toMatchObject({ status: "CANCELED", cancel_reason: "position_closed", qty_filled: "0.00000000" });
        await reservesReleased(u);

        await sweepAt("90000", QTY);
        expect((await position(u)).base_qty).toBe("0.00000000");
        await noNegativeUsd();
    });

    it("the position shrank: the sweep fills only what's left and cancels the rest; never flips", async () => {
        const u = await trader();
        await market(u, "BUY", QTY, { leverage: lev() });
        const id = await restingTp(u);
        await market(u, "SELL", "0.00600000", { reduceOnly: true });

        await sweepAt("90000", QTY);
        expect(await orderRow(id)).toMatchObject({
            status: "CANCELED", qty_filled: "0.00400000", cancel_reason: "reduce_only_no_position",
        });
        expect((await position(u)).base_qty).toBe("0.00000000");
        await reservesReleased(u);
        await noNegativeUsd();
    });

    it("filled as a maker, it journals as TP (not MANUAL)", async () => {
        const u = await trader();
        await market(u, "BUY", QTY, { leverage: lev() });
        await restingTp(u);
        await sweepAt("90000", QTY);
        const { rows } = await pool.query(`SELECT close_reason FROM closed_trades WHERE user_id = $1`, [u]);
        expect(rows).toEqual([{ close_reason: "TP" }]);
    });

    it("an ordinary resting LIMIT is untouched by a close (not reduce-only)", async () => {
        const u = await trader();
        await market(u, "BUY", QTY, { leverage: lev() });
        const r = await limit(u, "SELL", QTY, "95000", lev());
        await market(u, "SELL", QTY, { reduceOnly: true });
        expect(await orderRow(r.order.id)).toMatchObject({ status: "OPEN", reduce_only: false });
    });
});

describe("TP limit vs liquidation (10x long past its liq price)", () => {
    const SIZE = "0.00602409";
    let u: string;
    beforeEach(async () => {
        flagOn();
        u = await trader("1000.00000000");
        await market(u, "BUY", SIZE, { leverage: 10 });
        seedReferenceBook(pairId, "75000", "75000"); // past liq 75,075.38
    });

    it("liquidation first: the TP's LIMIT finds nothing to reduce → CANCELED no_position, nothing opened", async () => {
        const tp = await trigger(u, "TAKE_PROFIT_LIMIT", "74000", "74000", SIZE);
        const release = await holdPairLock();
        const liq = liquidate(u, 1, SIZE);
        await waitBlocked(1);
        const fire = fireTrigger(tp, { last: "74000" }); // its clamp read the position before the liquidation committed
        await waitBlocked(2);
        await release();
        await liq;
        await fire;
        expect(await triggerRow(tp.id)).toMatchObject({ status: "CANCELED", fail_reason: "no_position", derived_order_id: null });
        const p = await position(u);
        expect(p).toEqual({ base_qty: "0.00000000", epoch: 1 });
        await reservesReleased(u);
        await noNegativeUsd();
    });

    it("TP first (rests): the liquidation closes the position and cancels the resting TP; a later sweep opens nothing", async () => {
        const tp = await trigger(u, "TAKE_PROFIT_LIMIT", "74000", "76000", SIZE);
        const release = await holdPairLock();
        const fire = fireTrigger(tp, { last: "74000" });
        await waitBlocked(1);
        const liq = liquidate(u, 1, SIZE);
        await waitBlocked(2);
        await release();
        await fire;
        await liq;
        const derived = (await triggerRow(tp.id)).derived_order_id!;
        expect(await orderRow(derived)).toMatchObject({ status: "CANCELED", cancel_reason: "position_closed" });
        const { rows } = await pool.query(`SELECT 1 FROM liquidations WHERE mode = 'EXECUTED' AND user_id = $1`, [u]);
        expect(rows).toHaveLength(1);

        await sweepAt("76000", SIZE);
        expect(await position(u)).toEqual({ base_qty: "0.00000000", epoch: 1 });
        await reservesReleased(u);
        await noNegativeUsd();
    });

    it("TP first (fills against a resting bid): it closes; the liquidation is a no-op", async () => {
        const bidder = await trader("100000.00000000");
        await limit(bidder, "BUY", SIZE, "75000");
        const tp = await trigger(u, "TAKE_PROFIT_LIMIT", "74000", "74000", SIZE);
        const release = await holdPairLock();
        const fire = fireTrigger(tp, { last: "74000" });
        await waitBlocked(1);
        const liq = liquidate(u, 1, SIZE);
        await waitBlocked(2);
        await release();
        await fire;
        await expect(liq).rejects.toMatchObject({ reason: "flat" });
        expect((await position(u)).base_qty).toBe("0.00000000");
        const { rows } = await pool.query(`SELECT 1 FROM liquidations WHERE mode = 'EXECUTED'`);
        expect(rows).toEqual([]);
        await noNegativeUsd();
    });
});

describe.each([
    ["SPOT (flag off)", () => {}],
    ["ISOLATED (flag on, 10x)", flagOn],
])("SL limit vs the user's manual close, %s", (_label, setup) => {
    const QTY = "0.01000000";
    let u: string;
    beforeEach(async () => {
        setup();
        u = await trader();
        await market(u, "BUY", QTY, { leverage: config.leverage.enabled ? 10 : undefined });
        seedReferenceBook(pairId, "81000", "81000");
    });

    it("close first: the SL's LIMIT finds nothing → CANCELED no_position, no short opened", async () => {
        const sl = await trigger(u, "STOP_LIMIT", "81500", "82500", QTY);
        const release = await holdPairLock();
        const close = market(u, "SELL", QTY, { reduceOnly: true });
        await waitBlocked(1);
        const fire = fireTrigger(sl, { last: "81000" });
        await waitBlocked(2);
        await release();
        await close;
        await fire;
        expect(await triggerRow(sl.id)).toMatchObject({ status: "CANCELED", fail_reason: "no_position" });
        expect((await position(u)).base_qty).toBe("0.00000000");
        await reservesReleased(u);
    });

    it("SL first (rests): the close cancels it; a later sweep opens no short", async () => {
        const sl = await trigger(u, "STOP_LIMIT", "81500", "82500", QTY);
        const release = await holdPairLock();
        const fire = fireTrigger(sl, { last: "81000" });
        await waitBlocked(1);
        const close = market(u, "SELL", QTY, { reduceOnly: true });
        await waitBlocked(2);
        await release();
        await fire;
        await close;
        const derived = (await triggerRow(sl.id)).derived_order_id!;
        expect(await orderRow(derived)).toMatchObject({ status: "CANCELED", cancel_reason: "position_closed" });

        await sweepAt("82500", QTY);
        expect((await position(u)).base_qty).toBe("0.00000000");
        await reservesReleased(u);
        await noNegativeUsd();
    });
});
