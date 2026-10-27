/**
 * flatRowModel.test.ts: a flat position row never hands its old model to the
 * next position (leverage PR 7).
 *
 * The bug: positions keep one row per (user, pair, scope). A closed ISOLATED
 * position leaves that row flat but still margin_mode = 'ISOLATED' (with its
 * leverage, epoch). With LEVERAGE_ENABLED off, the next order trades SPOT
 * (resolveTakerMargin: flat → the flag decides), but the SPOT fill path only
 * wrote qty/entry, so the row came out "open ISOLATED with margin 0" and the
 * close then settled ISOLATED: base kept in the wallet, no margin, the loss
 * cap at 0.
 *
 * Now a SPOT fill that opens from a flat ISOLATED row resets it to a fresh
 * SPOT episode (SPOT, 1x, margin 0, no liq price, next epoch). Checked
 * against a pure-SPOT round trip, ledger line for ledger line. Also: with the
 * caps at 1 and in a match, a reopened position gets fresh leverage, margin
 * and epoch from the new order.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { pool } from "../../db/pool";
import { config } from "../../config";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { resetMarketDataPairIdCache } from "../../market/marketSymbols";
import { placeOrderWithSnapshot } from "../phase6OrderService";
import { createMatch, acceptMatch } from "../../competitions/matchService";

let pairId: string;
let btcAssetId: string;
let usdAssetId: string;
const saved = { ...config.leverage };

const flagOn = () => Object.assign(config.leverage, {
    enabled: true, liquidationMode: "log_only", maxFreePlay: 10, maxMatch: 5, maxCompetition: 1, allowlist: [],
});
const flagOff = () => Object.assign(config.leverage, { enabled: false });

async function trader(): Promise<string> {
    const u = await createTestUser(pool);
    await createTestWallets(pool, u.id, btcAssetId, usdAssetId, "0.00000000", "10000.00000000");
    return u.id;
}

const order = (uid: string, side: "BUY" | "SELL", qty: string, leverage?: number, matchId: string | null = null) =>
    placeOrderWithSnapshot(uid, { pairId, side, type: "MARKET", qty, leverage }, undefined, undefined, null, matchId);

type Pos = { base_qty: string; margin_mode: string; leverage: string; isolated_margin: string; liq_price: string | null; epoch: number };
async function position(uid: string, matchId: string | null = null): Promise<Pos> {
    const { rows } = await pool.query<Pos>(
        `SELECT base_qty::text, margin_mode, leverage::text, isolated_margin::text, liq_price::text, epoch
         FROM positions WHERE user_id = $1 AND pair_id = $2 AND match_id IS NOT DISTINCT FROM $3`,
        [uid, pairId, matchId]);
    return rows[0];
}

/** The user's ledger lines after `since` (exclusive), as (asset, type, amount). */
async function ledgerSince(uid: string, since: Date, matchId: string | null = null) {
    const { rows } = await pool.query<{ asset: string; entry_type: string; amount: string }>(
        `SELECT CASE WHEN w.asset_id = $2 THEN 'BTC' ELSE 'USD' END AS asset, l.entry_type, l.amount::text
         FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id
         WHERE w.user_id = $1 AND l.created_at > $3 AND w.match_id IS NOT DISTINCT FROM $4
         ORDER BY l.created_at, l.ctid`,
        [uid, btcAssetId, since, matchId]);
    return rows;
}

async function balances(uid: string, matchId: string | null = null) {
    const { rows } = await pool.query<{ asset: string; balance: string; reserved: string }>(
        `SELECT CASE WHEN asset_id = $2 THEN 'BTC' ELSE 'USD' END AS asset, balance::text, reserved::text
         FROM wallets WHERE user_id = $1 AND match_id IS NOT DISTINCT FROM $3 ORDER BY asset`,
        [uid, btcAssetId, matchId]);
    return rows;
}

const now = async (): Promise<Date> => (await pool.query<{ t: Date }>(`SELECT clock_timestamp() AS t`)).rows[0].t;

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

describe("flag off after an ISOLATED position: the next round trip is pure SPOT", () => {
    it("wallets and ledger match a pure-SPOT round trip; no base kept; the row is a fresh SPOT episode", async () => {
        const a = await trader();
        const b = await trader(); // never traded ISOLATED
        flagOn();
        await order(a, "BUY", "0.01000000", 10);
        await order(a, "SELL", "0.01000000");
        expect((await position(a)).margin_mode).toBe("ISOLATED");

        flagOff();
        const since = await now();
        const before = await balances(a);
        // The same SPOT round trip for both, at the same prices.
        for (const u of [a, b]) {
            seedReferenceBook(pairId, "83000", "83000");
            await order(u, "BUY", "0.00100000");
            const mid = await position(u);
            expect(mid).toMatchObject({ base_qty: "0.00100000", margin_mode: "SPOT", leverage: "1.00", isolated_margin: "0.00000000", liq_price: null });
            seedReferenceBook(pairId, "82000", "82000");
            await order(u, "SELL", "0.00100000");
        }

        // Ledger: line for line the same as b's (b's lines are all after `since` too).
        expect(await ledgerSince(a, since)).toEqual(await ledgerSince(b, since));
        expect((await ledgerSince(a, since)).map((l) => l.entry_type)).not.toContain("MARGIN_LOCK");

        // Wallets moved exactly as b's did: BTC back to where it started, USD down by the loss + fees.
        const after = await balances(a);
        const bAfter = await balances(b);
        const delta = (x: typeof after, y: typeof after, asset: string) =>
            Number(x.find((w) => w.asset === asset)!.balance) - Number(y.find((w) => w.asset === asset)!.balance);
        expect(after.find((w) => w.asset === "BTC")!.balance).toBe(before.find((w) => w.asset === "BTC")!.balance);
        expect(delta(after, before, "USD")).toBeCloseTo(delta(bAfter, [{ asset: "USD", balance: "10000", reserved: "0" }, { asset: "BTC", balance: "0", reserved: "0" }], "USD"), 8);

        // Every order of the round trip traded SPOT.
        const { rows } = await pool.query(`SELECT margin_mode FROM orders WHERE user_id = $1 AND created_at > $2`, [a, since]);
        expect(rows.map((r) => r.margin_mode)).toEqual(["SPOT", "SPOT"]);
        expect(await position(a)).toMatchObject({ base_qty: "0.00000000", margin_mode: "SPOT", leverage: "1.00", isolated_margin: "0.00000000", liq_price: null, epoch: 2 });
    });

    it("a SPOT resting order filled into a flat ISOLATED row (maker side) also starts a fresh SPOT episode", async () => {
        const a = await trader();
        flagOn();
        await order(a, "BUY", "0.01000000", 10);
        await order(a, "SELL", "0.01000000");
        flagOff();
        await placeOrderWithSnapshot(a, { pairId, side: "BUY", type: "LIMIT", qty: "0.00100000", limitPrice: "83000" });
        const taker = await trader();
        await createTestWallets(pool, taker, btcAssetId, usdAssetId, "1.00000000", "0.00000000").catch(() => {});
        await pool.query(`UPDATE wallets SET balance = 1 WHERE user_id = $1 AND asset_id = $2`, [taker, btcAssetId]);
        await order(taker, "SELL", "0.00100000");
        expect(await position(a)).toMatchObject({ base_qty: "0.00100000", margin_mode: "SPOT", leverage: "1.00", isolated_margin: "0.00000000", liq_price: null });
        await order(a, "SELL", "0.00100000");
        expect((await position(a)).base_qty).toBe("0.00000000");
        expect((await balances(a)).find((w) => w.asset === "BTC")!.balance).toBe("0.00000000");
    });
});

describe("flat-row reuse stays fresh with the caps at 1 and in a match", () => {
    it("caps = 1 (flag on): the reopened position is 1x with margin = notional, not the old 10x", async () => {
        const a = await trader();
        flagOn();
        await order(a, "BUY", "0.01000000", 10);
        await order(a, "SELL", "0.01000000");
        Object.assign(config.leverage, { maxFreePlay: 1 });
        await order(a, "BUY", "0.00100000");
        const p = await position(a);
        expect(p).toMatchObject({ margin_mode: "ISOLATED", leverage: "1.00", epoch: 2, base_qty: "0.00100000" });
        expect(Number(p.isolated_margin)).toBeCloseTo(83, 6); // 0.001 × 83,000 at 1x
        await expect(order(a, "BUY", "0.00100000", 10)).rejects.toThrow(/leverage_mismatch|leverage_exceeds_cap/);
        await order(a, "SELL", "0.00100000");
        expect((await position(a)).base_qty).toBe("0.00000000");
    });

    it("in an ISOLATED match, flag turned off: the reopened position gets fresh leverage (1x), margin and epoch", async () => {
        const a = await trader();
        const b = await trader();
        flagOn();
        const m = await createMatch(a, b, 24, [pairId]);
        await acceptMatch(m.id, b);
        await order(a, "BUY", "0.01000000", 5, m.id);
        await order(a, "SELL", "0.01000000", undefined, m.id);
        flagOff(); // the stamp keeps the match ISOLATED; the cap falls to 1
        await order(a, "BUY", "0.00100000", undefined, m.id);
        const p = await position(a, m.id);
        expect(p).toMatchObject({ margin_mode: "ISOLATED", leverage: "1.00", epoch: 2, base_qty: "0.00100000" });
        expect(Number(p.isolated_margin)).toBeCloseTo(83, 6);
        const usdBefore = Number((await balances(a, m.id)).find((w) => w.asset === "USD")!.balance);
        await order(a, "SELL", "0.00100000", undefined, m.id);
        const usdAfter = Number((await balances(a, m.id)).find((w) => w.asset === "USD")!.balance);
        // Margin back, minus the taker fee on the close (5 bps of $83).
        expect(usdAfter - usdBefore).toBeCloseTo(83 - 83 * 0.0005, 6);
        expect((await balances(a, m.id)).find((w) => w.asset === "BTC")!.balance).toBe("0.00000000");
    });
});
