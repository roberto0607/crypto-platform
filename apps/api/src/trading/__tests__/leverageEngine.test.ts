/**
 * leverageEngine.test.ts: the ISOLATED engine path behind LEVERAGE_ENABLED
 * (docs/designs/2026-10-13-leverage-design.md §2.2, PR 2).
 *
 * A real user's order in an ISOLATED scope never moves base. The USD wallet
 * is the only balance: opening locks margin (MARGIN_LOCK) and charges the fee
 * (FEE); reducing releases margin pro rata (MARGIN_RELEASE) and books P&L
 * (REALIZED_PNL) with the loss capped at the released margin
 * (LIQUIDATION_SHORTFALL records anything beyond). Bots and @system.local
 * users stay on the spot path.
 *
 * Real Postgres and the real order pipeline. BTC/USD: taker 5 bps, maker
 * 2 bps, maintenance margin 50 bps. The numbers are the design's worked
 * example: $50 at 10x long BTC at $83,000.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../notifications/notificationService", () => ({
    notifyTriggerFired: vi.fn().mockResolvedValue(undefined),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Decimal from "decimal.js";
import { pool } from "../../db/pool";
import { config } from "../../config";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets, fundTestMatchWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { allowSymbolForTest } from "../../market/marketSymbols";
import { placeOrderWithSnapshot, cancelOrderWithOutbox } from "../phase6OrderService";
import { createTriggerOrder } from "../../triggers/triggerRepo";
import { fireTrigger } from "../../triggers/triggerEngine";

let pairId: string;
let btcAssetId: string;
let usdAssetId: string;
let userId: string;

const savedLeverage = { ...config.leverage };

function enableLeverage(overrides: Partial<typeof config.leverage> = {}) {
    Object.assign(config.leverage, {
        enabled: true, maxFreePlay: 10, maxMatch: 5, maxCompetition: 1, allowlist: [], ...overrides,
    });
}

type Scope = { competitionId?: string | null; matchId?: string | null };

const order = (
    uid: string,
    side: "BUY" | "SELL",
    qty: string,
    leverage?: number,
    scope: Scope = {},
    pair = pairId,
) => placeOrderWithSnapshot(
    uid, { pairId: pair, side, type: "MARKET", qty, leverage },
    undefined, undefined, scope.competitionId ?? null, scope.matchId ?? null,
);

const limit = (uid: string, side: "BUY" | "SELL", qty: string, limitPrice: string, leverage?: number) =>
    placeOrderWithSnapshot(uid, { pairId, side, type: "LIMIT", qty, limitPrice, leverage });

async function newTrader(usd = "1000.00000000"): Promise<string> {
    const u = await createTestUser(pool);
    await createTestWallets(pool, u.id, btcAssetId, usdAssetId, "0.00000000", usd);
    return u.id;
}

/** A wallet row in a scope (free-play by default). */
async function wallet(uid: string, assetId: string, scope: Scope = {}) {
    const { rows } = await pool.query<{ id: string; balance: string; reserved: string }>(
        `SELECT id, balance::text, reserved::text FROM wallets
         WHERE user_id = $1 AND asset_id = $2
           AND competition_id IS NOT DISTINCT FROM $3 AND match_id IS NOT DISTINCT FROM $4`,
        [uid, assetId, scope.competitionId ?? null, scope.matchId ?? null],
    );
    return rows[0];
}
const usd = async (uid: string, scope: Scope = {}) => (await wallet(uid, usdAssetId, scope)).balance;
const btc = async (uid: string, scope: Scope = {}) => (await wallet(uid, btcAssetId, scope)).balance;

type Pos = {
    base_qty: string; avg_entry_price: string; realized_pnl_quote: string; fees_paid_quote: string;
    margin_mode: string; leverage: string; isolated_margin: string; liq_price: string | null;
    epoch: number; opened_at: string | null;
};
async function position(uid: string, scope: Scope = {}, pair = pairId): Promise<Pos | undefined> {
    const { rows } = await pool.query<Pos>(
        `SELECT base_qty::text, avg_entry_price::text, realized_pnl_quote::text, fees_paid_quote::text,
                margin_mode, leverage::text, isolated_margin::text, liq_price::text, epoch, opened_at::text
         FROM positions
         WHERE user_id = $1 AND pair_id = $2
           AND competition_id IS NOT DISTINCT FROM $3 AND match_id IS NOT DISTINCT FROM $4`,
        [uid, pair, scope.competitionId ?? null, scope.matchId ?? null],
    );
    return rows[0];
}

/** USD ledger entries for a user (in order), as [type, amount]. */
async function usdLedger(uid: string, scope: Scope = {}): Promise<[string, string][]> {
    const w = await wallet(uid, usdAssetId, scope);
    const { rows } = await pool.query<{ entry_type: string; amount: string }>(
        // One transaction's rows share created_at; ctid keeps their insert order.
        `SELECT entry_type, amount::text FROM ledger_entries WHERE wallet_id = $1 ORDER BY created_at, ctid`,
        [w.id],
    );
    return rows.map((r) => [r.entry_type, r.amount]);
}

const cents = (v: string | null | undefined) =>
    v == null ? null : Number(new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2));

const START = new Decimal("1000");
// $50 at 10x at 83,000: size 0.00602409 (rounded down), notional 499.99947.
const SIZE = "0.00602409";
const MARGIN = new Decimal("49.99994700");
const OPEN_FEE = new Decimal("0.24999973");

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
    userId = await newTrader();
    seedReferenceBook(pairId, "83000", "83000");
});

afterEach(() => {
    Object.assign(config.leverage, savedLeverage, { allowlist: [...savedLeverage.allowlist] });
});

describe("open (flag on, free-play)", () => {
    beforeEach(() => enableLeverage());

    it("$50 at 10x long at 83,000: locks margin, charges the fee, liq 75,075.38, base untouched", async () => {
        const res = await order(userId, "BUY", SIZE, 10);
        expect(res.order.status).toBe("FILLED");

        expect(await usd(userId)).toBe(START.minus(MARGIN).minus(OPEN_FEE).toFixed(8));
        expect(await btc(userId)).toBe("0.00000000");
        expect(await usdLedger(userId)).toEqual([
            ["MARGIN_LOCK", "-49.99994700"],
            ["FEE", "-0.24999973"],
        ]);

        const p = (await position(userId))!;
        expect(p.margin_mode).toBe("ISOLATED");
        expect(p.base_qty).toBe(SIZE);
        expect(p.avg_entry_price).toBe("83000.00000000");
        expect(Number(p.leverage)).toBe(10);
        expect(p.isolated_margin).toBe("49.99994700");
        expect(cents(p.liq_price)).toBe(75075.38);
        expect(p.epoch).toBe(1);
        expect(p.opened_at).not.toBeNull();
        expect(p.fees_paid_quote).toBe("0.24999973");

        const { rows: [o] } = await pool.query<{ leverage: string; margin_mode: string }>(
            `SELECT leverage::text, margin_mode FROM orders WHERE id = $1`, [res.order.id]);
        expect(Number(o.leverage)).toBe(10);
        expect(o.margin_mode).toBe("ISOLATED");
    });

    it("$50 at 10x short: liq 90,845.77, no negative base", async () => {
        await order(userId, "SELL", SIZE, 10);
        expect(await usd(userId)).toBe(START.minus(MARGIN).minus(OPEN_FEE).toFixed(8));
        expect(await btc(userId)).toBe("0.00000000");
        const p = (await position(userId))!;
        expect(p.base_qty).toBe("-0.00602409");
        expect(cents(p.liq_price)).toBe(90845.77);
    });

    it("no leverage given opens at 1x", async () => {
        await order(userId, "BUY", "0.01000000");
        const p = (await position(userId))!;
        expect(p.margin_mode).toBe("ISOLATED");
        expect(Number(p.leverage)).toBe(1);
        expect(p.isolated_margin).toBe("830.00000000");
        expect(Number(p.liq_price)).toBe(0);
    });
});

describe("reduce and close", () => {
    beforeEach(() => enableLeverage());

    it("partial close of half at 85,000: +$30.90 to USD, margin released pro rata, liq unchanged", async () => {
        await order(userId, "BUY", SIZE, 10);
        const before = new Decimal(await usd(userId));
        seedReferenceBook(pairId, "85000", "85000");

        await order(userId, "SELL", "0.00301205");
        const credit = new Decimal(await usd(userId)).minus(before);
        expect(cents(credit.toFixed(8))).toBe(30.90);

        const types = (await usdLedger(userId)).map(([t]) => t);
        expect(types).toEqual(["MARGIN_LOCK", "FEE", "MARGIN_RELEASE", "REALIZED_PNL", "FEE"]);

        const p = (await position(userId))!;
        expect(p.base_qty).toBe("0.00301204");
        expect(cents(p.isolated_margin)).toBe(25.00);
        expect(cents(p.liq_price)).toBe(75075.38);
        expect(p.realized_pnl_quote).toBe("6.02410000");
        expect(p.epoch).toBe(1);
        expect(await btc(userId)).toBe("0.00000000");
    });

    it("a losing full close returns the leftover margin; flat clears margin and liq", async () => {
        await order(userId, "BUY", SIZE, 10);
        seedReferenceBook(pairId, "80000", "80000");
        await order(userId, "SELL", SIZE);

        // pnl = 0.00602409 × (80,000 − 83,000) = −18.07227; close fee on 481.9272.
        const pnl = new Decimal("-18.07227000");
        const closeFee = new Decimal("0.24096360");
        expect(await usd(userId)).toBe(START.minus(OPEN_FEE).plus(pnl).minus(closeFee).toFixed(8));

        const p = (await position(userId))!;
        expect(p.base_qty).toBe("0.00000000");
        expect(p.isolated_margin).toBe("0.00000000");
        expect(p.liq_price).toBeNull();
        expect(p.realized_pnl_quote).toBe("-18.07227000");
    });

    it("a gap past bankruptcy loses the margin and no more: shortfall recorded, USD never below what was left", async () => {
        await order(userId, "BUY", SIZE, 10);
        seedReferenceBook(pairId, "74000", "74000");
        await order(userId, "SELL", SIZE);

        // Lost exactly the margin + the open fee; the close fee couldn't be paid.
        expect(await usd(userId)).toBe(START.minus(MARGIN).minus(OPEN_FEE).toFixed(8));
        const ledger = await usdLedger(userId);
        expect(ledger.map(([t]) => t)).toEqual(["MARGIN_LOCK", "FEE", "MARGIN_RELEASE", "REALIZED_PNL", "LIQUIDATION_SHORTFALL"]);
        expect(ledger[3][1]).toBe("-49.99994700");
        expect(ledger[4][1]).toBe("0.00000000");

        const { rows: [s] } = await pool.query<{ shortfall: string }>(
            `SELECT metadata->>'shortfall' AS shortfall FROM ledger_entries WHERE entry_type = 'LIQUIDATION_SHORTFALL'`);
        expect(cents(s.shortfall)).toBe(4.22);

        const p = (await position(userId))!;
        expect(p.realized_pnl_quote).toBe("-49.99994700");
        expect(p.fees_paid_quote).toBe("0.24999973");
    });

    it("closing needs no spare cash", async () => {
        const poor = await newTrader("50.24994673"); // exactly margin + open fee
        await order(poor, "BUY", SIZE, 10);
        expect(await usd(poor)).toBe("0.00000000");
        await order(poor, "SELL", SIZE);
        expect((await position(poor))!.base_qty).toBe("0.00000000");
    });

    it("a flip closes the position and opens the rest at the fill, new epoch", async () => {
        await order(userId, "BUY", SIZE, 10);
        await order(userId, "SELL", "0.01000000", 10);
        const p = (await position(userId))!;
        expect(p.base_qty).toBe("-0.00397591");
        expect(p.avg_entry_price).toBe("83000.00000000");
        expect(p.epoch).toBe(2);
        expect(p.isolated_margin).toBe(new Decimal("0.00397591").mul(83000).div(10).toDecimalPlaces(8, Decimal.ROUND_DOWN).toFixed(8));
    });
});

describe("add to a position", () => {
    beforeEach(() => enableLeverage());

    it("add $50 at 10x at 80,000: averaged entry, summed margin, liq 73,693.62", async () => {
        await order(userId, "BUY", SIZE, 10);
        seedReferenceBook(pairId, "80000", "80000");
        await order(userId, "BUY", "0.00625000", 10);

        const p = (await position(userId))!;
        expect(p.base_qty).toBe("0.01227409");
        expect(cents(p.avg_entry_price)).toBe(81472.39);
        expect(p.isolated_margin).toBe("99.99994700");
        expect(cents(p.liq_price)).toBe(73693.62);
        expect(p.epoch).toBe(1);
    });

    it("an add at a different leverage is rejected; no leverage given inherits the position's", async () => {
        await order(userId, "BUY", SIZE, 10);
        await expect(order(userId, "BUY", "0.00100000", 5)).rejects.toThrow(/leverage_mismatch/);
        await order(userId, "BUY", "0.00100000");
        const p = (await position(userId))!;
        expect(Number(p.leverage)).toBe(10);
        expect(p.isolated_margin).toBe(MARGIN.plus("8.3").toFixed(8));
    });
});

describe("leverage caps", () => {
    it("free-play: up to 10x, 11x rejected", async () => {
        enableLeverage();
        await expect(order(userId, "BUY", "0.00100000", 11)).rejects.toThrow(/leverage_exceeds_cap/);
        await order(userId, "BUY", "0.00100000", 10);
    });

    it("a non-allowlisted user is held at 1x while the allowlist is set", async () => {
        const allowed = await newTrader();
        enableLeverage({ allowlist: [allowed] });

        await expect(order(userId, "BUY", "0.00100000", 2)).rejects.toThrow(/leverage_exceeds_cap/);
        await order(userId, "BUY", "0.00100000", 1);
        expect((await position(userId))!.margin_mode).toBe("ISOLATED");

        await order(allowed, "BUY", SIZE, 10);
        expect(Number((await position(allowed))!.leverage)).toBe(10);
    });

    it("an ISOLATED match uses its stamped cap (5x)", async () => {
        enableLeverage();
        const opponent = await newTrader();
        const { rows: [m] } = await pool.query<{ id: string }>(
            `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status, started_at, ends_at,
                                  margin_mode, max_leverage)
             VALUES ($1, $2, 24, '10000', 'ACTIVE', now(), now() + interval '1 day', 'ISOLATED', 5) RETURNING id`,
            [userId, opponent],
        );
        await fundTestMatchWallets(pool, m.id, [userId, opponent], "10000");
        const scope = { matchId: m.id };

        await expect(order(userId, "BUY", "0.01000000", 6, scope)).rejects.toThrow(/leverage_exceeds_cap/);
        await order(userId, "BUY", "0.01000000", 5, scope);

        const p = (await position(userId, scope))!;
        expect(p.margin_mode).toBe("ISOLATED");
        expect(Number(p.leverage)).toBe(5);
        expect(await usd(userId, scope)).toBe(new Decimal("10000").minus("166").minus("0.415").toFixed(8));
        expect(await btc(userId, scope)).toBe("0.00000000");
        // Free-play untouched.
        expect(await usd(userId)).toBe("1000.00000000");
    });

    it("a SPOT match (every match until PR 3 stamps them) trades spot even with the flag on", async () => {
        enableLeverage();
        const opponent = await newTrader();
        const { rows: [m] } = await pool.query<{ id: string }>(
            `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status, started_at, ends_at)
             VALUES ($1, $2, 24, '10000', 'ACTIVE', now(), now() + interval '1 day') RETURNING id`,
            [userId, opponent],
        );
        await fundTestMatchWallets(pool, m.id, [userId, opponent], "10000");
        const scope = { matchId: m.id };

        await expect(order(userId, "BUY", "0.01000000", 2, scope)).rejects.toThrow(/leverage_exceeds_cap/);
        await order(userId, "BUY", "0.01000000", undefined, scope);
        expect(await btc(userId, scope)).toBe("0.01000000");
        expect((await position(userId, scope))!.margin_mode).toBe("SPOT");
    });

    it("a competition is ISOLATED at 1x", async () => {
        enableLeverage();
        const { rows: [c] } = await pool.query<{ id: string }>(
            `INSERT INTO competitions (name, start_at, end_at) VALUES ('c', now(), now() + interval '1 day') RETURNING id`);
        for (const [asset, bal] of [[usdAssetId, "5000"], [btcAssetId, "0"]]) {
            await pool.query(
                `INSERT INTO wallets (user_id, asset_id, balance, reserved, competition_id) VALUES ($1, $2, $3, 0, $4)`,
                [userId, asset, bal, c.id]);
        }
        const scope = { competitionId: c.id };

        await expect(order(userId, "BUY", "0.01000000", 2, scope)).rejects.toThrow(/leverage_exceeds_cap/);
        await order(userId, "BUY", "0.01000000", 1, scope);
        const p = (await position(userId, scope))!;
        expect(p.margin_mode).toBe("ISOLATED");
        expect(Number(p.leverage)).toBe(1);
        expect(await btc(userId, scope)).toBe("0.00000000");
    });

    it("flag off: leverage above 1 is rejected and orders trade spot", async () => {
        await expect(order(userId, "BUY", "0.00100000", 2)).rejects.toThrow(/leverage_exceeds_cap/);
        await order(userId, "BUY", "0.00100000", 1);
        expect(await btc(userId)).toBe("0.00100000");
        expect((await position(userId))!.margin_mode).toBe("SPOT");
    });
});

describe("buying power", () => {
    beforeEach(() => enableLeverage());

    it("$1,000 opens $1,000 notional at 10x; $1,000 of margin at 10x doesn't fit the fee", async () => {
        await expect(order(userId, "BUY", "0.12048192", 10)).rejects.toThrow(/insufficient_balance/);
        await order(userId, "BUY", "0.01204819", 10); // $100 margin, $1,000 notional
        expect(cents((await position(userId))!.isolated_margin)).toBe(100.00);
    });

    it("a resting LIMIT reserves margin + max fee; cancel releases it", async () => {
        const res = await limit(userId, "BUY", "0.01000000", "80000", 10);
        expect(res.order.status).toBe("OPEN");
        // 0.01 × 80,000 / 10 + 0.01 × 80,000 × 5 bps
        expect((await wallet(userId, usdAssetId)).reserved).toBe("80.40000000");
        expect(await btc(userId)).toBe("0.00000000");

        await cancelOrderWithOutbox(userId, res.order.id);
        expect((await wallet(userId, usdAssetId)).reserved).toBe("0.00000000");
        expect(await usd(userId)).toBe("1000.00000000");
    });

    it("a resting short LIMIT also reserves USD, never base", async () => {
        await limit(userId, "SELL", "0.01000000", "90000", 5);
        expect((await wallet(userId, usdAssetId)).reserved).toBe("180.45000000");
        expect((await wallet(userId, btcAssetId)).reserved).toBe("0.00000000");
    });

    it("reserved margin counts: a second order can't spend it", async () => {
        await limit(userId, "BUY", "0.10000000", "80000", 10); // reserves 804
        await expect(order(userId, "BUY", "0.03000000", 10)).rejects.toThrow(/insufficient_balance/); // needs ~250
        await order(userId, "BUY", "0.02000000", 10); // needs ~166.8
    });
});

describe("maker legs", () => {
    beforeEach(() => enableLeverage());

    it("a resting ISOLATED LIMIT filled by another user opens from its reserve; the excess is released", async () => {
        const res = await limit(userId, "BUY", "0.01000000", "83000", 10); // no resting sellers: it rests
        expect(res.order.status).toBe("OPEN");
        const taker = await newTrader("100000.00000000");
        await order(taker, "SELL", "0.01000000", 2);

        // Maker: margin 83 + maker fee 0.166; reserve was 83 + 0.415.
        expect(await usd(userId)).toBe(new Decimal("1000").minus("83").minus("0.166").toFixed(8));
        expect((await wallet(userId, usdAssetId)).reserved).toBe("0.00000000");
        const mp = (await position(userId))!;
        expect(mp.margin_mode).toBe("ISOLATED");
        expect(mp.base_qty).toBe("0.01000000");
        expect(Number(mp.leverage)).toBe(10);

        // Taker: a 2x short, no base moved on either side.
        const tp = (await position(taker))!;
        expect(tp.base_qty).toBe("-0.01000000");
        expect(Number(tp.leverage)).toBe(2);
        expect(await btc(userId)).toBe("0.00000000");
        expect(await btc(taker)).toBe("0.00000000");
    });
});

describe("LIMIT taker + maker on one order", () => {
    beforeEach(() => enableLeverage());

    it("fills part now from free USD, reserves only the rest, then fills the rest from that reserve", async () => {
        const bot = (await createTestUser(pool, { email: "mmbot@system.local" })).id;
        await createTestWallets(pool, bot, btcAssetId, usdAssetId, "1.00000000", "100000.00000000");
        await limit(bot, "SELL", "0.00500000", "83000");

        const res = await limit(userId, "BUY", "0.01000000", "83000", 10);
        expect(res.order.status).toBe("PARTIALLY_FILLED");
        // Taken now: margin 41.5 + taker fee 0.2075. Reserved: 41.5 + 0.2075 (max fee).
        expect(await usd(userId)).toBe("958.29250000");
        expect((await wallet(userId, usdAssetId)).reserved).toBe("41.70750000");

        await order(bot, "SELL", "0.00500000"); // fills the resting rest as maker
        const p = (await position(userId))!;
        expect(p.base_qty).toBe("0.01000000");
        expect(p.isolated_margin).toBe("83.00000000");
        // Maker leg: margin 41.5 + maker fee 0.083 from the reserve; 0.1245 released.
        expect((await wallet(userId, usdAssetId)).reserved).toBe("0.00000000");
        expect(await usd(userId)).toBe("916.70950000");
        expect(await btc(userId)).toBe("0.00000000");
        const { rows: [o] } = await pool.query<{ status: string; reserved_consumed: string }>(
            `SELECT status, reserved_consumed::text FROM orders WHERE id = $1`, [res.order.id]);
        expect(o).toEqual({ status: "FILLED", reserved_consumed: "41.58300000" });
    });
});

describe("protective triggers (#202)", () => {
    beforeEach(() => enableLeverage());

    it("a stop that closes a 10x long settles ISOLATED and cancels the position's take-profit", async () => {
        await order(userId, "BUY", SIZE, 10);
        const sl = await createTriggerOrder({ userId, pairId, kind: "STOP_MARKET", side: "SELL", triggerPrice: "80000", qty: SIZE, matchId: null });
        const tp = await createTriggerOrder({ userId, pairId, kind: "TAKE_PROFIT_MARKET", side: "SELL", triggerPrice: "90000", qty: SIZE, matchId: null });

        seedReferenceBook(pairId, "80000", "80000");
        await fireTrigger(sl, { last: "80000" });

        const p = (await position(userId))!;
        expect(p.base_qty).toBe("0.00000000");
        expect(p.margin_mode).toBe("ISOLATED");
        expect(await btc(userId)).toBe("0.00000000");
        const { rows } = await pool.query<{ id: string; status: string }>(
            `SELECT id, status FROM trigger_orders WHERE id = ANY($1::uuid[])`, [[sl.id, tp.id]]);
        expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [sl.id]: "TRIGGERED", [tp.id]: "CANCELED" });
    });
});

describe("system users stay on the spot path", () => {
    async function botScenario(flagOn: boolean) {
        await resetTestData();
        clearReferenceBooks();
        const assets = await createTestAssetAndPair(pool);
        pairId = assets.pair.id;
        btcAssetId = assets.btcAsset.id;
        usdAssetId = assets.usdAsset.id;
        seedReferenceBook(pairId, "83000", "83000");
        const bot = (await createTestUser(pool, { email: "mmbot@system.local" })).id;
        await createTestWallets(pool, bot, btcAssetId, usdAssetId, "1.00000000", "100000.00000000");
        const user = await newTrader();
        if (flagOn) enableLeverage(); else Object.assign(config.leverage, savedLeverage);

        await limit(bot, "SELL", "0.01000000", "83000"); // bot rests liquidity
        await order(user, "BUY", "0.01000000", 1);        // a user takes it
        await order(bot, "SELL", "0.00100000");            // the bot trades as a taker

        const { rows } = await pool.query<{ asset: string; entry_type: string; amount: string; balance_after: string; metadata: unknown }>(
            `SELECT a.symbol AS asset, l.entry_type, l.amount::text, l.balance_after::text, l.metadata
             FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id JOIN assets a ON a.id = w.asset_id
             WHERE w.user_id = $1 ORDER BY l.created_at, l.ctid`, [bot]);
        const wallets = await pool.query(
            `SELECT a.symbol, w.balance::text, w.reserved::text FROM wallets w JOIN assets a ON a.id = w.asset_id
             WHERE w.user_id = $1 ORDER BY a.symbol`, [bot]);
        const pos = await pool.query(
            `SELECT base_qty::text, avg_entry_price::text, realized_pnl_quote::text, fees_paid_quote::text,
                    margin_mode, leverage::text, isolated_margin::text, liq_price, epoch
             FROM positions WHERE user_id = $1`, [bot]);
        return { ledger: rows, wallets: wallets.rows, positions: pos.rows, userPos: await position(user) };
    }

    it("the bot's ledger, wallets and position are identical with the flag off and on", async () => {
        const off = await botScenario(false);
        const on = await botScenario(true);
        expect(on.ledger).toEqual(off.ledger);
        expect(on.wallets).toEqual(off.wallets);
        expect(on.positions).toEqual(off.positions);
        expect(on.positions[0].margin_mode).toBe("SPOT");
        // The user's leg is the one that changed.
        expect(off.userPos!.margin_mode).toBe("SPOT");
        expect(on.userPos!.margin_mode).toBe("ISOLATED");
    });

    it("a system user can't use leverage", async () => {
        enableLeverage();
        const sys = (await createTestUser(pool, { email: "ops@system.local" })).id;
        await createTestWallets(pool, sys, btcAssetId, usdAssetId, "0.00000000", "100000.00000000");
        await expect(order(sys, "BUY", "0.01000000", 2)).rejects.toThrow(/leverage_exceeds_cap/);
    });
});

describe("pre-leverage state", () => {
    it("an open SPOT position keeps trading spot after the flag turns on", async () => {
        await order(userId, "BUY", "0.00100000");
        enableLeverage();
        await order(userId, "SELL", "0.00100000");
        expect(await btc(userId)).toBe("0.00000000");
        expect((await position(userId))!.margin_mode).toBe("SPOT");
        // Flat now: the next order opens ISOLATED.
        await order(userId, "BUY", "0.00100000", 2);
        expect((await position(userId))!.margin_mode).toBe("ISOLATED");
    });

    it("after the flag is turned back off, a resting ISOLATED order blocks a SPOT order on that pair", async () => {
        enableLeverage();
        await limit(userId, "BUY", "0.00100000", "80000", 2);
        Object.assign(config.leverage, savedLeverage);
        await expect(order(userId, "BUY", "0.00100000")).rejects.toThrow(/isolated_orders_open/);
    });

    it("rejects malformed leverage (below 1, more than 2 decimals)", async () => {
        enableLeverage();
        await expect(order(userId, "BUY", "0.00100000", 0.5)).rejects.toThrow(/invalid_leverage/);
        await expect(order(userId, "BUY", "0.00100000", 2.555)).rejects.toThrow(/invalid_leverage/);
    });

    it("a resting SPOT order blocks opening ISOLATED on that pair", async () => {
        await limit(userId, "SELL", "0.00100000", "90000");
        enableLeverage();
        await expect(order(userId, "BUY", "0.00100000", 2)).rejects.toThrow(/spot_orders_open/);
    });
});

describe("SOL maintenance margin (migration 097)", () => {
    it("sets SOL to 100 bps and leaves every other pair alone", async () => {
        const { rows: [sol] } = await pool.query<{ id: string }>(
            `INSERT INTO assets (symbol, name, decimals) VALUES ('SOL', 'Solana', 8) RETURNING id`);
        const { rows: [eth] } = await pool.query<{ id: string }>(
            `INSERT INTO assets (symbol, name, decimals) VALUES ('ETH', 'Ether', 8) RETURNING id`);
        const { rows: [solPair] } = await pool.query<{ id: string }>(
            `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active, last_price, maker_fee_bps, taker_fee_bps)
             VALUES ($1, $2, $3, true, '150', 2, 5) RETURNING id`, [sol.id, usdAssetId, allowSymbolForTest("SOL/USD")]);
        await pool.query(
            `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active, last_price, maker_fee_bps, taker_fee_bps)
             VALUES ($1, $2, 'ETH/USD', true, '2500', 2, 5)`, [eth.id, usdAssetId]);

        const sql = readFileSync(join(__dirname, "../../../migrations/097_sol_maintenance_margin.sql"), "utf8");
        await pool.query(sql);

        const { rows } = await pool.query<{ symbol: string; maintenance_margin_bps: number }>(
            `SELECT symbol, maintenance_margin_bps FROM trading_pairs ORDER BY symbol`);
        expect(Object.fromEntries(rows.map((r) => [r.symbol, r.maintenance_margin_bps]))).toEqual({
            "BTC/USD": 50, "ETH/USD": 50, "SOL/USD": 100,
        });

        // The engine reads it: a 10x SOL long's liq is 150 × 0.9 / 0.99.
        enableLeverage();
        await pool.query(`INSERT INTO wallets (user_id, asset_id, balance, reserved) VALUES ($1, $2, 0, 0)`, [userId, sol.id]);
        seedReferenceBook(solPair.id, "150", "150");
        await order(userId, "BUY", "1.00000000", 10, {}, solPair.id);
        expect(cents((await position(userId, {}, solPair.id))!.liq_price)).toBe(136.36);
    });
});
