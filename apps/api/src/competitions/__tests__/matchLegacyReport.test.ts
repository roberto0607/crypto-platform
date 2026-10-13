/**
 * matchLegacyReport.test.ts — the read-only footprint report for matches
 * from before per-match wallets (migration 095), when match fills moved the
 * players' FREE-PLAY wallets. Built on hand-made pre-095 rows: a COMPLETED
 * match whose fill debited/credited free-play, against a free-play maker.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { pool } from "../../db/pool";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { legacyFootprintRows, summarizeFootprint, footprintTotal } from "../matchLegacyReport";

let pairId: string;
let btcAssetId: string;
let usdAssetId: string;

async function walletsOf(uid: string) {
    const { rows } = await pool.query<{ id: string; asset_id: string }>(`SELECT id, asset_id FROM wallets WHERE user_id = $1`, [uid]);
    return { usd: rows.find((r) => r.asset_id === usdAssetId)!.id, btc: rows.find((r) => r.asset_id === btcAssetId)!.id };
}

async function order(uid: string, side: "BUY" | "SELL", matchId: string | null) {
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO orders (user_id, pair_id, side, type, qty, qty_filled, status, match_id)
         VALUES ($1, $2, $3, 'MARKET', '0.1', '0.1', 'FILLED', $4) RETURNING id`,
        [uid, pairId, side, matchId],
    );
    return rows[0].id;
}

async function trade(buyOrderId: string, sellOrderId: string) {
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO trades (pair_id, buy_order_id, sell_order_id, price, qty, quote_amount, fee_amount, fee_asset_id, is_system_fill)
         VALUES ($1, $2, $3, '50000', '0.1', '5000', '2.5', $4, false) RETURNING id`,
        [pairId, buyOrderId, sellOrderId, usdAssetId],
    );
    return rows[0].id;
}

async function ledger(walletId: string, type: string, amount: string, tradeId: string) {
    await pool.query(
        `INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, reference_id, reference_type)
         VALUES ($1, $2, $3, 0, $4, 'TRADE')`,
        [walletId, type, amount, tradeId],
    );
}

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    await resetTestData();
    const assets = await createTestAssetAndPair(pool); // last_price 50000
    pairId = assets.pair.id;
    btcAssetId = assets.btcAsset.id;
    usdAssetId = assets.usdAsset.id;
});

describe("matches:legacy-report", () => {
    it("reports each ended match's net effect on the player's free-play wallets, excluding the counterparty", async () => {
        const alice = (await createTestUser(pool, { email: "alice@test.com" })).id;
        const bob = (await createTestUser(pool, { email: "bob@test.com" })).id;
        const maker = (await createTestUser(pool, { email: "maker@test.com" })).id;
        for (const u of [alice, bob, maker]) await createTestWallets(pool, u, btcAssetId, usdAssetId, "0", "100000");
        const a = await walletsOf(alice);
        const m = await walletsOf(maker);

        const { rows: [match] } = await pool.query<{ id: string }>(
            `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status, started_at, ends_at, completed_at)
             VALUES ($1, $2, 24, '50000', 'COMPLETED', now() - interval '25 hours', now() - interval '1 hour', now() - interval '1 hour')
             RETURNING id`,
            [alice, bob],
        );

        // Pre-095 match fill: Alice buys 0.1 BTC in the match from a free-play maker,
        // and both legs land on FREE-PLAY wallets. The position was later
        // force-closed without moving any wallet, so the 0.1 BTC is still there.
        const t1 = await trade(await order(alice, "BUY", match.id), await order(maker, "SELL", null));
        await ledger(a.usd, "TRADE_BUY", "-5002.5", t1);
        await ledger(a.btc, "TRADE_BUY", "0.1", t1);
        await ledger(m.btc, "TRADE_SELL", "-0.1", t1); // counterparty: not the match's footprint
        await ledger(m.usd, "TRADE_SELL", "4999", t1);

        // A plain free-play trade by Alice: not a match footprint.
        const t2 = await trade(await order(alice, "BUY", null), await order(maker, "SELL", null));
        await ledger(a.usd, "TRADE_BUY", "-5002.5", t2);

        // An ACTIVE match is not reported (still in play).
        const { rows: [live] } = await pool.query<{ id: string }>(
            `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status, started_at, ends_at)
             VALUES ($1, $2, 24, '50000', 'ACTIVE', now(), now() + interval '1 day') RETURNING id`,
            [bob, maker],
        );
        const t3 = await trade(await order(bob, "BUY", live.id), await order(maker, "SELL", null));
        const b = await walletsOf(bob);
        await ledger(b.usd, "TRADE_BUY", "-5002.5", t3);

        const footprints = summarizeFootprint(await legacyFootprintRows(pool));
        expect(footprints).toHaveLength(1);
        const f = footprints[0];
        expect(f).toMatchObject({ match_id: match.id, user_id: alice, email: "alice@test.com", status: "COMPLETED" });
        const byAsset = Object.fromEntries(f.assets.map((x) => [x.asset, x]));
        expect(Number(byAsset.USD.net)).toBe(-5002.5);
        expect(Number(byAsset.BTC.net)).toBe(0.1);
        expect(Number(byAsset.BTC.value_usd)).toBe(5000); // at last_price 50000
        expect(Number(f.total_value_usd)).toBeCloseTo(-2.5, 8); // the match's net footprint ≈ the fee
        expect(Number(footprintTotal(footprints))).toBeCloseTo(-2.5, 8);

        // --match narrows to one match.
        expect(summarizeFootprint(await legacyFootprintRows(pool, live.id))).toEqual([]);
    });

    it("writes nothing", async () => {
        const before = await pool.query(`SELECT count(*) FROM ledger_entries`);
        await legacyFootprintRows(pool);
        const after = await pool.query(`SELECT count(*) FROM ledger_entries`);
        expect(after.rows[0]).toEqual(before.rows[0]);
    });
});
