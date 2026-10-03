/**
 * restrictPairs.test.ts — the one-time "deactivate everything outside
 * MARKET_SYMBOLS" data step (market/restrictPairs.ts), against the real test
 * DB. Fixture pairs use per-run symbols; planRestriction() sees the whole
 * table (other suites leave fixtures behind), so assertions only look at
 * this file's own pairs, and applyRestriction() is only ever handed those.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pool } from "../../db/pool";
import { parseMarketSymbols } from "../../config";
import { planRestriction, applyRestriction, revertPairs, type RestrictionTarget } from "../restrictPairs";

let uid: string;
let quoteAssetId: string;
let userId: string;
const pairIds: string[] = [];
const assetIds: string[] = [];
let allow: ReadonlySet<string>;

async function createPair(base: string): Promise<{ id: string; symbol: string }> {
    const { rows: [asset] } = await pool.query<{ id: string }>(
        `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $1, 8) RETURNING id`,
        [base],
    );
    assetIds.push(asset!.id);
    const symbol = `${base}/USD`;
    const { rows: [pair] } = await pool.query<{ id: string }>(
        `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active)
         VALUES ($1, $2, $3, true) RETURNING id`,
        [asset!.id, quoteAssetId, symbol],
    );
    pairIds.push(pair!.id);
    return { id: pair!.id, symbol };
}

async function addPosition(pairId: string) {
    await pool.query(
        `INSERT INTO positions (user_id, pair_id, base_qty, avg_entry_price)
         VALUES ($1, $2, '0.50000000', '10.00000000')`,
        [userId, pairId],
    );
}
async function addOpenOrder(pairId: string) {
    await pool.query(
        `INSERT INTO orders (user_id, pair_id, side, type, limit_price, qty, qty_filled, status,
                             reserved_wallet_id, reserved_amount, reserved_consumed, competition_id, match_id)
         VALUES ($1, $2, 'BUY', 'LIMIT', '9', '1.00000000', '0', 'OPEN', NULL, '0', '0', NULL, NULL)`,
        [userId, pairId],
    );
}
async function addTrigger(pairId: string) {
    await pool.query(
        `INSERT INTO trigger_orders (user_id, pair_id, kind, side, trigger_price, qty)
         VALUES ($1, $2, 'STOP_MARKET', 'SELL', '8', '0.10000000')`,
        [userId, pairId],
    );
}
async function addAlert(pairId: string) {
    await pool.query(
        `INSERT INTO alerts (user_id, pair_id, condition_type, target_value, frequency)
         VALUES ($1, $2, 'CROSSING', '12', 'ONCE')`,
        [userId, pairId],
    );
}
async function isActive(pairId: string): Promise<boolean> {
    const { rows } = await pool.query<{ is_active: boolean }>(`SELECT is_active FROM trading_pairs WHERE id = $1`, [pairId]);
    return rows[0]!.is_active;
}
async function targetsFor(ids: string[]): Promise<RestrictionTarget[]> {
    return (await planRestriction(allow)).targets.filter((t) => ids.includes(t.id));
}

beforeEach(async () => {
    uid = Math.random().toString(36).slice(2, 7).toUpperCase();
    const { rows: [q] } = await pool.query<{ id: string }>(
        `INSERT INTO assets (symbol, name, decimals) VALUES ($1, 'quote', 2) RETURNING id`,
        [`RQ${uid}`],
    );
    quoteAssetId = q!.id;
    assetIds.push(q!.id);
    const { rows: [u] } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, email_normalized, password_hash, role)
         VALUES ($1, LOWER($1), 'test-hash', 'USER') RETURNING id`,
        [`restrict-${uid}@test.local`],
    );
    userId = u!.id;
    allow = parseMarketSymbols(`KEEP${uid}-USD`);
});

afterEach(async () => {
    await pool.query(`DELETE FROM alerts WHERE pair_id = ANY($1)`, [pairIds]);
    await pool.query(`DELETE FROM trigger_orders WHERE pair_id = ANY($1)`, [pairIds]);
    await pool.query(`DELETE FROM orders WHERE pair_id = ANY($1)`, [pairIds]);
    await pool.query(`DELETE FROM positions WHERE pair_id = ANY($1)`, [pairIds]);
    await pool.query(`DELETE FROM trading_pairs WHERE id = ANY($1)`, [pairIds]);
    await pool.query(`DELETE FROM assets WHERE id = ANY($1)`, [assetIds]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    pairIds.length = 0;
    assetIds.length = 0;
});

describe("planRestriction", () => {
    it("keeps allowlisted pairs and lists every other active pair with its live holdings", async () => {
        const keep = await createPair(`KEEP${uid}`);
        const doge = await createPair(`DG${uid}`);
        await addPosition(doge.id);
        await addOpenOrder(doge.id);
        await addTrigger(doge.id);
        await addAlert(doge.id);

        const plan = await planRestriction(allow);

        expect(plan.allowed).toEqual([keep.symbol]);
        expect(plan.keep).toEqual([keep.symbol]);
        expect(plan.missingAllowed).toEqual([]);
        expect(plan.targets.map((t) => t.id)).not.toContain(keep.id);
        expect(plan.targets.find((t) => t.id === doge.id)).toEqual({
            id: doge.id, symbol: doge.symbol,
            openPositions: 1, openOrders: 1, activeTriggers: 1, activeAlerts: 1,
        });
    });

    it("flags an allowlisted symbol that has no active row", async () => {
        const plan = await planRestriction(allow);
        expect(plan.missingAllowed).toEqual([`KEEP${uid}/USD`]);
    });
});

describe("applyRestriction", () => {
    it("deactivates clean and position-only pairs, skips ones with open orders/triggers, deletes nothing", async () => {
        const clean = await createPair(`CL${uid}`);
        const posOnly = await createPair(`PO${uid}`);
        const withOrder = await createPair(`OR${uid}`);
        const withTrigger = await createPair(`TR${uid}`);
        await addPosition(posOnly.id);
        await addOpenOrder(withOrder.id);
        await addTrigger(withTrigger.id);

        const res = await applyRestriction(await targetsFor(pairIds), { allow });

        expect(res.deactivated.map((p) => p.id).sort()).toEqual([clean.id, posOnly.id].sort());
        expect(res.skipped.map((p) => p.id).sort()).toEqual([withOrder.id, withTrigger.id].sort());
        expect(await isActive(clean.id)).toBe(false);
        expect(await isActive(posOnly.id)).toBe(false);
        expect(await isActive(withOrder.id)).toBe(true);
        expect(await isActive(withTrigger.id)).toBe(true);
        // Position, order and trigger rows are untouched.
        const { rows } = await pool.query(
            `SELECT (SELECT count(*) FROM positions WHERE pair_id = $1)::int AS pos,
                    (SELECT count(*) FROM orders WHERE pair_id = $2 AND status = 'OPEN')::int AS ord,
                    (SELECT count(*) FROM trigger_orders WHERE pair_id = $3 AND status = 'ACTIVE')::int AS trg`,
            [posOnly.id, withOrder.id, withTrigger.id],
        );
        expect(rows[0]).toEqual({ pos: 1, ord: 1, trg: 1 });
    });

    it("with cancelOpen, cancels open orders, triggers and alerts first, then deactivates", async () => {
        const held = await createPair(`HD${uid}`);
        await addOpenOrder(held.id);
        await addTrigger(held.id);
        await addAlert(held.id);

        const res = await applyRestriction(await targetsFor(pairIds), { cancelOpen: true, allow });

        expect(res.deactivated.map((p) => p.id)).toEqual([held.id]);
        expect(res.skipped).toEqual([]);
        expect(res.canceledOrderIds).toHaveLength(1);
        expect(res.canceledTriggerIds).toHaveLength(1);
        expect(res.canceledAlertIds).toHaveLength(1);
        const { rows } = await pool.query(
            `SELECT (SELECT status FROM orders WHERE pair_id = $1) AS ord,
                    (SELECT status FROM trigger_orders WHERE pair_id = $1) AS trg,
                    (SELECT status FROM alerts WHERE pair_id = $1) AS alr`,
            [held.id],
        );
        expect(rows[0]).toEqual({ ord: "CANCELED", trg: "CANCELED", alr: "CANCELLED" });
        expect(await isActive(held.id)).toBe(false);
    });

    it("never deactivates an allowlisted pair — a target list containing one rolls back whole", async () => {
        const keep = await createPair(`KEEP${uid}`);
        const other = await createPair(`OT${uid}`);
        const forged: RestrictionTarget[] = [keep, other].map((p) => ({
            ...p, openPositions: 0, openOrders: 0, activeTriggers: 0, activeAlerts: 0,
        }));

        await expect(applyRestriction(forged, { allow })).rejects.toThrow(/guard mismatch/);
        expect(await isActive(keep.id)).toBe(true);
        expect(await isActive(other.id)).toBe(true); // rolled back, not half-applied
    });
});

describe("revertPairs", () => {
    it("re-activates exactly the recorded pairs", async () => {
        const a = await createPair(`RA${uid}`);
        const b = await createPair(`RB${uid}`);
        const { deactivated } = await applyRestriction(await targetsFor(pairIds), { allow });
        expect(deactivated).toHaveLength(2);

        const restored = await revertPairs([a.id]);

        expect(restored.map((p) => p.id)).toEqual([a.id]);
        expect(await isActive(a.id)).toBe(true);
        expect(await isActive(b.id)).toBe(false);
        // Idempotent: already-active ids are a no-op.
        expect(await revertPairs([a.id])).toEqual([]);
    });
});
