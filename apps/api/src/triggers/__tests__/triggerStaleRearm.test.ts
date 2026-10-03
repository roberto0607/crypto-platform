/**
 * triggerStaleRearm.test.ts — a TP/SL whose market order hits a stale Kraken
 * book is re-armed, not FAILED.
 *
 * Triggers fire on Coinbase price.tick, but their MARKET order is collared
 * against the Kraken book and rejected with stale_price_source while that book
 * is >5s old (e.g. a Kraken WS reconnect). Marking the trigger FAILED there
 * would silently drop a user's stop-loss for a transient feed blip, so the
 * trigger — and the OCO sibling the firing canceled — go back to ACTIVE and
 * fire again on a later tick.
 *
 * End to end against the real test Postgres: real placeOrderWithSnapshot and
 * matching engine; only push notifications are stubbed.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

vi.mock("../../notifications/notificationService", () => ({
    notifyTriggerFired: vi.fn().mockResolvedValue(undefined),
}));

import { randomUUID } from "node:crypto";
import { pool } from "../../db/pool";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { createTriggerOrder } from "../triggerRepo";
import { fireTrigger, evaluateTriggersForPair, STALE_REARM_BACKOFF_MS } from "../triggerEngine";

let userId: string;
let pairId: string;

async function statusOf(id: string) {
    const { rows } = await pool.query<{ status: string; derived_order_id: string | null; fail_reason: string | null }>(
        `SELECT status, derived_order_id, fail_reason FROM trigger_orders WHERE id = $1`,
        [id],
    );
    return rows[0];
}

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    await resetTestData();
    clearReferenceBooks();
    const user = await createTestUser(pool);
    userId = user.id;
    const assets = await createTestAssetAndPair(pool);
    pairId = assets.pair.id;
    await createTestWallets(pool, userId, assets.btcAsset.id, assets.usdAsset.id, "1.00000000", "100000.00000000");
});

describe("trigger + stale Kraken book", () => {
    it("re-arms the trigger and its OCO sibling instead of failing, then fires once the book is fresh", async () => {
        const oco = randomUUID();
        const stop = await createTriggerOrder({
            userId, pairId, kind: "STOP_MARKET", side: "SELL", triggerPrice: "49000", qty: "0.10000000", ocoGroupId: oco,
        });
        const takeProfit = await createTriggerOrder({
            userId, pairId, kind: "TAKE_PROFIT_MARKET", side: "SELL", triggerPrice: "52000", qty: "0.10000000", ocoGroupId: oco,
        });

        // Kraken book is 6s old → the stop's market order is rejected.
        seedReferenceBook(pairId, "48990", "49000", 6_000);
        await fireTrigger(stop, { last: "48990" });

        expect(await statusOf(stop.id)).toMatchObject({ status: "ACTIVE", derived_order_id: null, fail_reason: null });
        expect((await statusOf(takeProfit.id)).status).toBe("ACTIVE");

        // Feed recovers → the next firing goes through.
        seedReferenceBook(pairId, "48990", "49000");
        await fireTrigger(stop, { last: "48990" });

        const fired = await statusOf(stop.id);
        expect(fired.status).toBe("TRIGGERED");
        expect(fired.derived_order_id).not.toBeNull();
        expect((await statusOf(takeProfit.id)).status).toBe("CANCELED");
    });

    it("backs off before re-firing a re-armed trigger on the next ticks", async () => {
        const stop = await createTriggerOrder({
            userId, pairId, kind: "STOP_MARKET", side: "SELL", triggerPrice: "49000", qty: "0.10000000",
        });
        seedReferenceBook(pairId, "48990", "49000", 6_000);
        await evaluateTriggersForPair(pairId, { last: "48990" }); // fires → stale → re-armed

        // Book is fresh again, but we're inside the backoff: no new attempt yet.
        seedReferenceBook(pairId, "48990", "49000");
        await evaluateTriggersForPair(pairId, { last: "48990" });
        expect((await statusOf(stop.id)).status).toBe("ACTIVE");

        await new Promise((r) => setTimeout(r, STALE_REARM_BACKOFF_MS + 50));
        await evaluateTriggersForPair(pairId, { last: "48990" });
        expect((await statusOf(stop.id)).status).toBe("TRIGGERED");
    });

    it("other order failures still mark the trigger FAILED", async () => {
        await pool.query(`UPDATE wallets SET balance = 0 WHERE user_id = $1`, [userId]);
        const stop = await createTriggerOrder({
            userId, pairId, kind: "STOP_MARKET", side: "SELL", triggerPrice: "49000", qty: "0.10000000",
        });
        seedReferenceBook(pairId, "48990", "49000");
        await fireTrigger(stop, { last: "48990" });

        expect(await statusOf(stop.id)).toMatchObject({ status: "FAILED", fail_reason: "insufficient_balance" });
    });
});
