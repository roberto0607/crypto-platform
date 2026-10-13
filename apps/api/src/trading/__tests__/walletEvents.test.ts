/**
 * walletEvents.test.ts: every order that moves a balance sends wallet.updated
 * to each owner after COMMIT, so the order panel's AVAILABLE is live.
 *
 * Regression for QA F4 (2026-10-11): AVAILABLE stayed stale after every fill,
 * close and cancel until a reload. Trading moves wallets through the *Tx
 * helpers, which published nothing, and the maker of a fill got no event of
 * any kind.
 *
 * Real Postgres and the real order pipeline; only the event bus is spied.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

vi.mock("../../events/eventBus", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../events/eventBus")>();
    return { ...actual, publish: vi.fn() };
});

import { pool } from "../../db/pool";
import { publish } from "../../events/eventBus";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { placeOrderWithSnapshot, cancelOrderWithOutbox, cancelAllOrdersWithOutbox } from "../phase6OrderService";

let pairId: string;
let btcAssetId: string;
let usdAssetId: string;

async function trader(btc = "0.00000000") {
    const u = await createTestUser(pool);
    await createTestWallets(pool, u.id, btcAssetId, usdAssetId, btc, "100000.00000000");
    return u.id;
}

type WalletEvent = { type: string; userId?: string; data: { walletId: string; assetId: string; balance: string; reserved: string } };

/** wallet.updated events published since the last reset, for one user. */
function walletEvents(userId: string): WalletEvent[] {
    return vi.mocked(publish).mock.calls
        .map(([e]) => e as unknown as WalletEvent)
        .filter((e) => e.type === "wallet.updated" && e.userId === userId);
}

async function wallet(userId: string, assetId: string) {
    const { rows } = await pool.query<{ id: string; balance: string; reserved: string }>(
        `SELECT id, balance::text, reserved::text FROM wallets WHERE user_id = $1 AND asset_id = $2`,
        [userId, assetId],
    );
    return rows[0];
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
    seedReferenceBook(pairId, "50000", "50000");
    vi.mocked(publish).mockClear();
});

describe("wallet.updated after orders", () => {
    it("a market fill updates the taker's USD and BTC wallets with the committed balances", async () => {
        const taker = await trader();
        await placeOrderWithSnapshot(taker, { pairId, side: "BUY", type: "MARKET", qty: "0.01000000" });

        const events = walletEvents(taker);
        const usd = await wallet(taker, usdAssetId);
        const btc = await wallet(taker, btcAssetId);
        expect(events.map((e) => e.data.walletId).sort()).toEqual([usd.id, btc.id].sort());
        expect(events.find((e) => e.data.walletId === usd.id)!.data).toMatchObject({ balance: usd.balance, reserved: usd.reserved });
        expect(events.find((e) => e.data.walletId === btc.id)!.data.balance).toBe(btc.balance);
        expect(Number(usd.balance)).toBeLessThan(100000);
    });

    it("the maker of a fill gets wallet.updated for its own wallets", async () => {
        const maker = await trader("1.00000000");
        const taker = await trader();
        await placeOrderWithSnapshot(maker, { pairId, side: "SELL", type: "LIMIT", qty: "0.01000000", limitPrice: "50000" });
        vi.mocked(publish).mockClear();

        const res = await placeOrderWithSnapshot(taker, { pairId, side: "BUY", type: "MARKET", qty: "0.01000000" });
        expect(res.fills.length).toBeGreaterThan(0);

        const makerUsd = await wallet(maker, usdAssetId);
        const makerBtc = await wallet(maker, btcAssetId);
        const events = walletEvents(maker);
        expect(events.map((e) => e.data.walletId).sort()).toEqual([makerUsd.id, makerBtc.id].sort());
        expect(events.find((e) => e.data.walletId === makerUsd.id)!.data.balance).toBe(makerUsd.balance);
        expect(Number(makerUsd.balance)).toBeGreaterThan(100000);
    });

    it("a resting limit sends its hold, and cancelling it sends the release", async () => {
        const uid = await trader();
        const { order } = await placeOrderWithSnapshot(uid, { pairId, side: "BUY", type: "LIMIT", qty: "0.01000000", limitPrice: "40000" });
        const usdId = (await wallet(uid, usdAssetId)).id;

        const hold = walletEvents(uid).find((e) => e.data.walletId === usdId);
        expect(Number(hold!.data.reserved)).toBeGreaterThan(0);

        vi.mocked(publish).mockClear();
        await cancelOrderWithOutbox(uid, order.id);
        const release = walletEvents(uid).find((e) => e.data.walletId === usdId);
        expect(release!.data.reserved).toBe((await wallet(uid, usdAssetId)).reserved);
        expect(Number(release!.data.reserved)).toBe(0);
    });

    it("a bulk cancel sends one release per wallet to each owner", async () => {
        const uid = await trader();
        await placeOrderWithSnapshot(uid, { pairId, side: "BUY", type: "LIMIT", qty: "0.01000000", limitPrice: "40000" });
        await placeOrderWithSnapshot(uid, { pairId, side: "BUY", type: "LIMIT", qty: "0.01000000", limitPrice: "39000" });
        vi.mocked(publish).mockClear();

        await cancelAllOrdersWithOutbox({ userId: uid });
        const events = walletEvents(uid);
        expect(events).toHaveLength(1);
        expect(Number(events[0].data.reserved)).toBe(0);
    });
});
