/**
 * leverageConversion.test.ts: the one-time SPOT → ISOLATED conversion
 * (leverage PR 5, docs/designs/2026-10-13-leverage-design.md §1, §6, §7).
 *
 *   what       every open SPOT position of a real user, free-play or a
 *              competition, becomes a 1x ISOLATED position at its entry:
 *              the base wallet gives up exactly the position's qty, the
 *              margin (qty × entry) is locked out of USD after the base is
 *              settled to USD at the same price. Resting SPOT orders on a
 *              converted pair are canceled first. Matches, bots and
 *              @system.local users are never touched.
 *   equity     identical before and after, to the cent (to 1e-8), at any
 *              mark, measured with the app's own getPortfolioSummary and
 *              with wallets × mark.
 *   dry run    the default: the plan, nothing written.
 *   once       a second run changes nothing; each user in its own
 *              transaction; one failure doesn't stop or half-apply others.
 *   live       same lock order as trading (pair → wallets → positions):
 *              races with the user's own order, a maker fill, a second
 *              run and the liquidation engine all end consistent.
 *
 * Real Postgres. Positions are opened through the real order path with
 * LEVERAGE_ENABLED off (how every prod position was opened).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { pool } from "../../db/pool";
import { config } from "../../config";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { placeOrderWithSnapshot } from "../phase6OrderService";
import { getPortfolioSummary } from "../../portfolio/portfolioService";
import { createMatch, acceptMatch } from "../../competitions/matchService";
import { LiquidationEngine } from "../liquidationEngine";
import { createTriggerOrder } from "../../triggers/triggerRepo";
import { fireTrigger } from "../../triggers/triggerEngine";
import { allowSymbolForTest } from "../../market/marketSymbols";
import {
    convertedPosition,
    applyUserConversion,
    runConversion,
    formatRun,
    parseConvertArgs,
    CONVERSION_CANCEL_REASON,
} from "../leverageConversion";

let pairId: string;
let btcAssetId: string;
let usdAssetId: string;

const savedLeverage = { ...config.leverage };

const flagOff = () => Object.assign(config.leverage, { enabled: false, liquidationMode: "log_only" });
const flagOn = () => Object.assign(config.leverage, {
    enabled: true, liquidationMode: "log_only", maxFreePlay: 10, maxMatch: 5, maxCompetition: 1, allowlist: [],
});

async function trader(usd = "100000.00000000", email?: string): Promise<string> {
    const u = await createTestUser(pool, email ? { email } : {});
    await createTestWallets(pool, u.id, btcAssetId, usdAssetId, "0.00000000", usd);
    return u.id;
}

const market = (uid: string, side: "BUY" | "SELL", qty: string, competitionId: string | null = null, matchId: string | null = null) =>
    placeOrderWithSnapshot(uid, { pairId, side, type: "MARKET", qty }, undefined, undefined, competitionId, matchId);

const limit = (uid: string, side: "BUY" | "SELL", qty: string, price: string) =>
    placeOrderWithSnapshot(uid, { pairId, side, type: "LIMIT", qty, limitPrice: price });

async function setMark(price: string): Promise<void> {
    await pool.query(`UPDATE trading_pairs SET last_price = $1 WHERE id = $2`, [price, pairId]);
}

type Wallet = { balance: string; reserved: string };
async function wallet(uid: string, assetId: string, competitionId: string | null = null): Promise<Wallet> {
    const { rows } = await pool.query<Wallet>(
        `SELECT balance::text, reserved::text FROM wallets
         WHERE user_id = $1 AND asset_id = $2 AND competition_id IS NOT DISTINCT FROM $3 AND match_id IS NULL`,
        [uid, assetId, competitionId],
    );
    return rows[0];
}

type Pos = {
    base_qty: string; avg_entry_price: string; margin_mode: string; leverage: string; isolated_margin: string;
    liq_price: string | null; epoch: number; realized_pnl_quote: string; fees_paid_quote: string; opened_at: string | null;
};
async function position(uid: string, scope: { competitionId?: string | null; matchId?: string | null } = {}): Promise<Pos> {
    const { rows } = await pool.query<Pos>(
        `SELECT base_qty::text, avg_entry_price::text, margin_mode, leverage::text, isolated_margin::text,
                liq_price::text, epoch, realized_pnl_quote::text, fees_paid_quote::text, opened_at::text
         FROM positions WHERE user_id = $1 AND pair_id = $2
           AND competition_id IS NOT DISTINCT FROM $3 AND match_id IS NOT DISTINCT FROM $4`,
        [uid, pairId, scope.competitionId ?? null, scope.matchId ?? null],
    );
    return rows[0];
}

/** Everything the conversion may write, for "nothing changed" compares. */
async function dbState() {
    const q = async (sql: string) => (await pool.query(sql)).rows;
    return {
        wallets: await q(`SELECT id, balance::text, reserved::text FROM wallets ORDER BY id`),
        ledger: await q(`SELECT id, wallet_id, entry_type, amount::text FROM ledger_entries ORDER BY id`),
        positions: await q(`SELECT user_id, pair_id, competition_id, match_id, base_qty::text, avg_entry_price::text,
                                   margin_mode, leverage::text, isolated_margin::text, liq_price::text, epoch,
                                   realized_pnl_quote::text, fees_paid_quote::text
                            FROM positions ORDER BY user_id, pair_id, competition_id, match_id`),
        orders: await q(`SELECT id, status, cancel_reason FROM orders ORDER BY id`),
        outbox: await q(`SELECT id FROM outbox_events ORDER BY id`),
        audit: await q(`SELECT id FROM audit_log ORDER BY id`),
    };
}

/** The app's equity (portfolio summary) at each mark. */
async function equityAt(uid: string, marks: string[], competitionId: string | null = null): Promise<string[]> {
    const out: string[] = [];
    for (const m of marks) {
        await setMark(m);
        out.push((await getPortfolioSummary(uid, undefined, competitionId)).equity_quote);
    }
    return out;
}

/** USD + Σ base wallet × mark: equity counted from the wallets alone (SPOT) plus ISOLATED margin + uPnL. */
async function walletEquityAt(uid: string, mark: string, competitionId: string | null = null): Promise<Decimal> {
    const usd = new Decimal((await wallet(uid, usdAssetId, competitionId)).balance);
    const base = new Decimal((await wallet(uid, btcAssetId, competitionId)).balance);
    const p = await position(uid, { competitionId });
    let isolated = new Decimal(0);
    if (p && p.margin_mode === "ISOLATED" && !new Decimal(p.base_qty).isZero()) {
        isolated = new Decimal(p.isolated_margin).plus(new Decimal(p.base_qty).mul(new Decimal(mark).minus(p.avg_entry_price)));
    }
    return usd.plus(base.mul(mark)).plus(isolated);
}

const MARKS = ["60000", "83000", "120000"];

function expectSameEquity(before: string[], after: string[]): void {
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
        const diff = new Decimal(after[i]).minus(before[i]).abs();
        expect(diff.lte("0.00000001"), `mark ${MARKS[i]}: ${before[i]} → ${after[i]}`).toBe(true);
        expect(new Decimal(after[i]).toFixed(2)).toBe(new Decimal(before[i]).toFixed(2));
    }
}

async function noNegativeUsd(): Promise<void> {
    const { rows } = await pool.query(
        `SELECT user_id, balance::text FROM wallets WHERE asset_id = $1 AND balance < 0`, [usdAssetId]);
    expect(rows).toEqual([]);
}

async function holdLock(sql: string, params: unknown[]): Promise<() => Promise<void>> {
    const client: PoolClient = await pool.connect();
    await client.query("BEGIN");
    await client.query(sql, params);
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

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    await resetTestData();
    clearReferenceBooks();
    flagOff();
    const assets = await createTestAssetAndPair(pool);
    pairId = assets.pair.id;
    btcAssetId = assets.btcAsset.id;
    usdAssetId = assets.usdAsset.id;
    seedReferenceBook(pairId, "83000", "83000");
    await setMark("83000");
});

afterEach(() => {
    Object.assign(config.leverage, savedLeverage, { allowlist: [...savedLeverage.allowlist] });
});

// ── The conversion math (pure) ──────────────────────────────────────────

describe("convertedPosition", () => {
    it("a long q @ P: margin q·P at 1x, liq 0, USD +q·P settled then −q·P locked (net 0)", () => {
        const c = convertedPosition({ qty: new Decimal("0.1"), entry: new Decimal("83000"), mmrBps: 50 });
        expect(c.side).toBe("LONG");
        expect(c.margin.toFixed(8)).toBe("8300.00000000");
        expect(c.liqPrice.toFixed(8)).toBe("0.00000000");
        expect(c.baseDelta.toFixed(8)).toBe("-0.10000000");
        expect(c.usdSettle.toFixed(8)).toBe("8300.00000000");
        expect(c.usdDelta.toFixed(8)).toBe("0.00000000");
    });

    it("a short q @ P: buy-back −q·P, margin −q·P (USD −2·q·P), liq = 2P / (1 + MMR) = 165,174.13 (§3)", () => {
        const c = convertedPosition({ qty: new Decimal("-0.1"), entry: new Decimal("83000"), mmrBps: 50 });
        expect(c.side).toBe("SHORT");
        expect(c.margin.toFixed(8)).toBe("8300.00000000");
        expect(c.liqPrice.toFixed(8)).toBe("165174.12935323");
        expect(c.baseDelta.toFixed(8)).toBe("0.10000000");
        expect(c.usdSettle.toFixed(8)).toBe("-8300.00000000");
        expect(c.usdDelta.toFixed(8)).toBe("-16600.00000000");
    });

    it("equity M + uPnL − (what the base was worth) is 0 at any mark (long and short)", () => {
        for (const qty of ["0.12345678", "-0.12345678"]) {
            const q = new Decimal(qty);
            const entry = new Decimal("81472.39123456");
            const c = convertedPosition({ qty: q, entry, mmrBps: 100 });
            for (const m of ["1", "40000", "81472.39123456", "150000"]) {
                const mark = new Decimal(m);
                const before = q.mul(mark);                                     // base × mark
                const after = c.usdDelta.plus(c.margin).plus(q.mul(mark.minus(entry))); // USD move + margin + uPnL
                expect(after.minus(before).abs().lte("0.00000001")).toBe(true);
            }
        }
    });
});

describe("parseConvertArgs (pnpm leverage:convert)", () => {
    const id = "338d993f-0444-4a0a-b463-d3cb6ce0d959";
    it("dry run unless --apply", () => {
        expect(parseConvertArgs([])).toEqual({ apply: false, userId: undefined });
        expect(parseConvertArgs(["--dry-run"])).toEqual({ apply: false, userId: undefined });
        expect(parseConvertArgs(["--apply"])).toEqual({ apply: true, userId: undefined });
        expect(parseConvertArgs(["--user", id])).toEqual({ apply: false, userId: id });
        expect(parseConvertArgs(["--apply", "--user", id])).toEqual({ apply: true, userId: id });
    });
    it("anything else is an error, never an apply", () => {
        expect(() => parseConvertArgs(["--aply"])).toThrow(/unknown argument/);
        expect(() => parseConvertArgs(["apply"])).toThrow(/unknown argument/);
        expect(() => parseConvertArgs(["--user"])).toThrow(/uuid/);
        expect(() => parseConvertArgs(["--user", "bob"])).toThrow(/uuid/);
        expect(() => parseConvertArgs(["--apply", "--dry-run"])).toThrow(/pick one/);
    });
});

// ── Converting ──────────────────────────────────────────────────────────

describe("a free-play long", () => {
    let alice: string;
    beforeEach(async () => {
        alice = await trader();
        await market(alice, "BUY", "0.10000000"); // 8,300 + 4.15 fee
    });

    it("dry run (the default): prints the plan and writes nothing", async () => {
        const before = await dbState();
        const run = await runConversion({ apply: false });
        expect(await dbState()).toEqual(before);

        expect(run.mode).toBe("DRY_RUN");
        const [u] = run.users;
        expect(u.userId).toBe(alice);
        expect(u.status).toBe("would_convert");
        const [s] = u.plan!.scopes;
        expect(s.competitionId).toBeNull();
        expect(s.usd.balanceBefore).toBe("91695.85000000");
        expect(s.usd.balanceAfter).toBe("91695.85000000");
        expect(s.positions).toEqual([expect.objectContaining({
            symbol: "BTC/USD", side: "LONG", qty: "0.10000000", entry: "83000.00000000", leverage: "1.00",
            margin: "8300.00000000", liqPrice: "0.00000000", baseBefore: "0.10000000", baseAfter: "0.00000000", residue: "0.00000000",
        })]);
        expect(s.ledger.map((l) => [l.asset, l.entryType, l.amount])).toEqual([
            ["BTC", "POSITION_CONVERSION", "-0.10000000"],
            ["USD", "POSITION_CONVERSION", "8300.00000000"],
            ["USD", "MARGIN_LOCK", "-8300.00000000"],
        ]);
        expect(s.equityBefore).toBe(s.equityAfter);

        const text = formatRun(run);
        expect(text).toContain("DRY RUN");
        expect(text).toContain(alice);
        expect(text).toContain("POSITION_CONVERSION");
        expect(text).toContain("nothing written");
    });

    it("--apply: 1x ISOLATED at the entry, base wallet 0, USD unchanged, new epoch, ledger as planned", async () => {
        const usdBefore = (await wallet(alice, usdAssetId)).balance;
        const posBefore = await position(alice);
        const run = await runConversion({ apply: true });
        expect(run.users.map((u) => [u.userId, u.status])).toEqual([[alice, "converted"]]);

        expect((await wallet(alice, btcAssetId)).balance).toBe("0.00000000");
        expect((await wallet(alice, usdAssetId)).balance).toBe(usdBefore);
        const p = await position(alice);
        expect(p).toMatchObject({
            base_qty: "0.10000000", avg_entry_price: "83000.00000000", margin_mode: "ISOLATED", leverage: "1.00",
            isolated_margin: "8300.00000000", liq_price: "0.00000000", epoch: posBefore.epoch + 1,
            realized_pnl_quote: posBefore.realized_pnl_quote, fees_paid_quote: posBefore.fees_paid_quote,
        });
        expect(p.opened_at).not.toBeNull();

        const { rows } = await pool.query(
            `SELECT a.symbol, l.entry_type, l.amount::text, l.metadata->>'pairId' AS pair, (l.metadata->>'epoch')::int AS epoch
             FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id JOIN assets a ON a.id = w.asset_id
             WHERE w.user_id = $1 AND l.entry_type IN ('POSITION_CONVERSION', 'MARGIN_LOCK') ORDER BY l.created_at, l.id`,
            [alice]);
        expect(rows.map((r) => [r.symbol, r.entry_type, r.amount])).toEqual(expect.arrayContaining([
            ["BTC", "POSITION_CONVERSION", "-0.10000000"],
            ["USD", "POSITION_CONVERSION", "8300.00000000"],
            ["USD", "MARGIN_LOCK", "-8300.00000000"],
        ]));
        expect(rows).toHaveLength(3);
        for (const r of rows) expect([r.pair, r.epoch]).toEqual([pairId, posBefore.epoch + 1]);

        const { rows: audit } = await pool.query(`SELECT action, target_id FROM audit_log WHERE action = 'leverage.convert'`);
        expect(audit).toEqual([{ action: "leverage.convert", target_id: alice }]);
    });

    it("equity is identical before and after, to the cent, at any mark (getPortfolioSummary and wallets × mark)", async () => {
        const before = await equityAt(alice, MARKS);
        const walletBefore = await Promise.all(MARKS.map((m) => walletEquityAt(alice, m)));
        await setMark("83000");
        await runConversion({ apply: true });
        expectSameEquity(before, await equityAt(alice, MARKS));
        for (let i = 0; i < MARKS.length; i++) {
            expect((await walletEquityAt(alice, MARKS[i])).minus(walletBefore[i]).abs().lte("0.00000001")).toBe(true);
        }
    });

    it("idempotent: a second run plans nothing and writes nothing", async () => {
        await runConversion({ apply: true });
        const after = await dbState();
        const again = await runConversion({ apply: true });
        expect(again.users).toEqual([]);
        expect(await dbState()).toEqual(after);
        expect((await runConversion({ apply: false })).users).toEqual([]);
    });

    it("the converted position trades on: closing it pays out what closing the spot position would have", async () => {
        await runConversion({ apply: true });
        seedReferenceBook(pairId, "84000", "84000");
        await market(alice, "SELL", "0.10000000");
        // Spot: 91,695.85 + 8,400 − 4.20 fee. ISOLATED: release 8,300 + pnl 100 − 4.20.
        expect((await wallet(alice, usdAssetId)).balance).toBe("100091.65000000");
        expect((await position(alice)).base_qty).toBe("0.00000000");
        expect((await wallet(alice, btcAssetId)).balance).toBe("0.00000000");
    });
});

describe("a free-play short", () => {
    let bob: string;
    beforeEach(async () => {
        bob = await trader();
        await market(bob, "SELL", "0.10000000"); // base −0.1, USD +8,300 − 4.15
    });

    it("base −q → 0 bought back at the entry, then the margin locked: USD −2·q·P; 1x liq 165,174.13", async () => {
        const usdBefore = new Decimal((await wallet(bob, usdAssetId)).balance);
        await runConversion({ apply: true });
        expect((await wallet(bob, btcAssetId)).balance).toBe("0.00000000");
        expect((await wallet(bob, usdAssetId)).balance).toBe(usdBefore.minus("16600").toFixed(8));
        expect(await position(bob)).toMatchObject({
            base_qty: "-0.10000000", margin_mode: "ISOLATED", leverage: "1.00",
            isolated_margin: "8300.00000000", liq_price: "165174.12935323",
        });
    });

    it("equity is identical before and after, to the cent, at any mark", async () => {
        const before = await equityAt(bob, MARKS);
        const walletBefore = await Promise.all(MARKS.map((m) => walletEquityAt(bob, m)));
        await setMark("83000");
        await runConversion({ apply: true });
        expectSameEquity(before, await equityAt(bob, MARKS));
        for (let i = 0; i < MARKS.length; i++) {
            expect((await walletEquityAt(bob, MARKS[i])).minus(walletBefore[i]).abs().lte("0.00000001")).toBe(true);
        }
    });

    it("a short whose 1x liq price is already at or below the mark is blocked, not converted", async () => {
        await setMark("166000");
        const before = await dbState();
        const run = await runConversion({ apply: true });
        expect(run.users.map((u) => [u.status, u.reason])).toEqual([["blocked", "short_past_liq"]]);
        expect(await dbState()).toEqual(before);
    });

    it("blocked when USD can't cover the buy-back and the margin; nothing written for that user", async () => {
        await pool.query(`UPDATE wallets SET balance = 10000 WHERE user_id = $1 AND asset_id = $2`, [bob, usdAssetId]);
        const before = await dbState();
        const run = await runConversion({ apply: true });
        expect(run.users.map((u) => [u.status, u.reason])).toEqual([["blocked", "insufficient_usd"]]);
        expect(await dbState()).toEqual(before);
        await noNegativeUsd();
    });
});

describe("resting SPOT orders", () => {
    it("on a converted pair: canceled first (holds released, cancel_reason, outbox); other users' orders untouched", async () => {
        const alice = await trader();
        const carol = await trader();
        await market(alice, "BUY", "0.10000000");
        const { order: buy } = await limit(alice, "BUY", "0.05000000", "80000");   // reserves USD
        const { order: sell } = await limit(alice, "SELL", "0.05000000", "90000"); // reserves BTC
        const { order: carols } = await limit(carol, "BUY", "0.01000000", "70000"); // carol has no position
        expect(new Decimal((await wallet(alice, usdAssetId)).reserved).gt(0)).toBe(true);
        expect(new Decimal((await wallet(alice, btcAssetId)).reserved).gt(0)).toBe(true);

        const dry = await runConversion({ apply: false });
        expect(dry.users).toHaveLength(1);
        expect(dry.users[0].plan!.scopes[0].cancels.map((c) => c.orderId).sort()).toEqual([buy.id, sell.id].sort());

        const before = await equityAt(alice, MARKS);
        await setMark("83000");
        await runConversion({ apply: true });

        const { rows } = await pool.query<{ id: string; status: string; cancel_reason: string | null }>(
            `SELECT id, status, cancel_reason FROM orders WHERE id = ANY($1)`, [[buy.id, sell.id, carols.id]]);
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(byId.get(buy.id)).toMatchObject({ status: "CANCELED", cancel_reason: CONVERSION_CANCEL_REASON });
        expect(byId.get(sell.id)).toMatchObject({ status: "CANCELED", cancel_reason: CONVERSION_CANCEL_REASON });
        expect(byId.get(carols.id)).toMatchObject({ status: "OPEN", cancel_reason: null });
        expect((await wallet(alice, usdAssetId)).reserved).toBe("0.00000000");
        expect((await wallet(alice, btcAssetId)).reserved).toBe("0.00000000");
        const { rows: outbox } = await pool.query(
            `SELECT aggregate_id FROM outbox_events WHERE aggregate_type = 'ORDER' AND payload->'eventInput'->>'eventType' = 'ORDER_CANCELLED'`);
        expect(outbox.map((o) => o.aggregate_id).sort()).toEqual([buy.id, sell.id].sort());
        expectSameEquity(before, await equityAt(alice, MARKS));
        expect((await position(carol))).toBeUndefined();
    });
});

describe("several pairs", () => {
    it("a BTC long and an ETH short with a resting ETH order: both convert, the ETH order is canceled, equity identical", async () => {
        allowSymbolForTest("ETH/USD");
        const { rows: [eth] } = await pool.query<{ id: string }>(
            `INSERT INTO assets (symbol, name, decimals) VALUES ('ETH', 'Ether', 8) RETURNING id`);
        const { rows: [ethPair] } = await pool.query<{ id: string }>(
            `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active, last_price, maker_fee_bps, taker_fee_bps)
             VALUES ($1, $2, 'ETH/USD', true, 3000, 2, 5) RETURNING id`, [eth.id, usdAssetId]);
        seedReferenceBook(ethPair.id, "3000", "3000");
        const alice = await trader();
        await pool.query(`INSERT INTO wallets (user_id, asset_id, balance, reserved) VALUES ($1, $2, 0, 0)`, [alice, eth.id]);

        await market(alice, "BUY", "0.10000000");
        await placeOrderWithSnapshot(alice, { pairId: ethPair.id, side: "SELL", type: "MARKET", qty: "2.00000000" });
        const { order: ethLimit } = await placeOrderWithSnapshot(alice, { pairId: ethPair.id, side: "BUY", type: "LIMIT", qty: "1.00000000", limitPrice: "2500" });

        const equity = async () => (await getPortfolioSummary(alice, undefined, null)).equity_quote;
        const before = await equity();
        const run = await runConversion({ apply: true });
        expect(run.users.map((u) => u.status)).toEqual(["converted"]);
        expect(run.users[0].plan!.scopes[0].positions.map((p) => [p.symbol, p.side]).sort()).toEqual([["BTC/USD", "LONG"], ["ETH/USD", "SHORT"]]);
        expect(await equity()).toBe(before);

        const { rows } = await pool.query<{ symbol: string; margin_mode: string; isolated_margin: string; liq_price: string }>(
            `SELECT tp.symbol, p.margin_mode, p.isolated_margin::text, p.liq_price::text
             FROM positions p JOIN trading_pairs tp ON tp.id = p.pair_id WHERE p.user_id = $1 ORDER BY tp.symbol`, [alice]);
        expect(rows).toEqual([
            { symbol: "BTC/USD", margin_mode: "ISOLATED", isolated_margin: "8300.00000000", liq_price: "0.00000000" },
            { symbol: "ETH/USD", margin_mode: "ISOLATED", isolated_margin: "6000.00000000", liq_price: "5970.14925373" },
        ]);
        const { rows: [o] } = await pool.query(`SELECT status, cancel_reason FROM orders WHERE id = $1`, [ethLimit.id]);
        expect(o).toEqual({ status: "CANCELED", cancel_reason: CONVERSION_CANCEL_REASON });
        const { rows: w } = await pool.query(`SELECT balance::text, reserved::text FROM wallets WHERE user_id = $1 AND asset_id = $2`, [alice, eth.id]);
        expect(w).toEqual([{ balance: "0.00000000", reserved: "0.00000000" }]);
        await noNegativeUsd();
    });
});

describe("TP/SL set before the conversion", () => {
    it("still protects the converted position: the stop closes it in full and nothing reopens", async () => {
        const alice = await trader();
        await market(alice, "BUY", "0.10000000");
        const sl = await createTriggerOrder({ userId: alice, pairId, kind: "STOP_MARKET", side: "SELL", triggerPrice: "80000", qty: "0.10000000", matchId: null });
        await runConversion({ apply: true });

        seedReferenceBook(pairId, "79000", "79000");
        await fireTrigger(sl, { last: "79000" });
        const p = await position(alice);
        expect(p).toMatchObject({ base_qty: "0.00000000", margin_mode: "ISOLATED", isolated_margin: "0.00000000" });
        // 91,695.85 + release 8,300 − 400 loss − 3.95 fee.
        expect((await wallet(alice, usdAssetId)).balance).toBe("99591.90000000");
        expect((await wallet(alice, btcAssetId)).balance).toBe("0.00000000");
    });
});

describe("drift: the base wallet disagrees with the position row", () => {
    it("converts the position's qty; the difference stays in the base wallet and is reported; equity identical", async () => {
        const alice = await trader();
        await market(alice, "BUY", "0.10000000");
        // e.g. a pre-#207 match fill that moved the free-play wallet but not this position.
        await pool.query(`UPDATE wallets SET balance = balance + 0.03 WHERE user_id = $1 AND asset_id = $2`, [alice, btcAssetId]);

        const dry = await runConversion({ apply: false });
        expect(dry.users[0].plan!.scopes[0].positions[0]).toMatchObject({
            qty: "0.10000000", baseBefore: "0.13000000", baseAfter: "0.03000000", residue: "0.03000000",
        });
        expect(formatRun(dry)).toContain("residue");

        const before = await equityAt(alice, MARKS);
        const walletBefore = await Promise.all(MARKS.map((m) => walletEquityAt(alice, m)));
        await setMark("83000");
        await runConversion({ apply: true });
        expect((await wallet(alice, btcAssetId)).balance).toBe("0.03000000");
        expectSameEquity(before, await equityAt(alice, MARKS));
        for (let i = 0; i < MARKS.length; i++) {
            expect((await walletEquityAt(alice, MARKS[i])).minus(walletBefore[i]).abs().lte("0.00000001")).toBe(true);
        }
    });
});

describe("who and what is never converted", () => {
    it("bots and @system.local users", async () => {
        const bot = await trader("100000.00000000", "mm@system.local");
        await market(bot, "BUY", "0.10000000");
        const before = await dbState();
        const run = await runConversion({ apply: true });
        expect(run.users).toEqual([]);
        expect(run.skippedSystemUsers).toBe(1);
        expect(await dbState()).toEqual(before);
    });

    it("open match positions (the match's own wallets); the same user's free-play position converts", async () => {
        const alice = await trader();
        const bob = await trader();
        const m = await createMatch(alice, bob, 24, [pairId]);
        await acceptMatch(m.id, bob); // flag off: a SPOT match
        await market(alice, "BUY", "0.05000000", null, m.id);
        await market(alice, "BUY", "0.10000000");

        const matchBefore = await position(alice, { matchId: m.id });
        const { rows: matchWalletsBefore } = await pool.query(
            `SELECT id, balance::text, reserved::text FROM wallets WHERE match_id = $1 ORDER BY id`, [m.id]);
        await runConversion({ apply: true });

        expect(await position(alice, { matchId: m.id })).toEqual(matchBefore);
        expect(matchBefore.margin_mode).toBe("SPOT");
        const { rows: matchWalletsAfter } = await pool.query(
            `SELECT id, balance::text, reserved::text FROM wallets WHERE match_id = $1 ORDER BY id`, [m.id]);
        expect(matchWalletsAfter).toEqual(matchWalletsBefore);
        expect((await position(alice)).margin_mode).toBe("ISOLATED");
    });

    it("positions already ISOLATED, and flat SPOT rows", async () => {
        flagOn();
        const alice = await trader();
        await market(alice, "BUY", "0.10000000");      // ISOLATED (flag on)
        flagOff();
        const bob = await trader();
        await market(bob, "BUY", "0.10000000");
        await market(bob, "SELL", "0.10000000");       // SPOT, flat
        const before = await dbState();
        expect((await runConversion({ apply: true })).users).toEqual([]);
        expect(await dbState()).toEqual(before);
    });
});

describe("a competition", () => {
    it("converts in the competition's own wallets; free-play untouched by it; equity identical per scope", async () => {
        const alice = await trader();
        const { rows: [comp] } = await pool.query<{ id: string }>(
            `INSERT INTO competitions (name, start_at, end_at) VALUES ('c', now(), now() + interval '1 day') RETURNING id`);
        for (const [asset, bal] of [[usdAssetId, "20000"], [btcAssetId, "0"]]) {
            await pool.query(`INSERT INTO wallets (user_id, asset_id, balance, reserved, competition_id) VALUES ($1, $2, $3, 0, $4)`,
                [alice, asset, bal, comp.id]);
        }
        await market(alice, "SELL", "0.10000000", comp.id);
        await market(alice, "BUY", "0.20000000");

        const compBefore = await equityAt(alice, MARKS, comp.id);
        const freeBefore = await equityAt(alice, MARKS, null);
        await setMark("83000");
        const run = await runConversion({ apply: true });
        expect(run.users[0].plan!.scopes.map((s) => s.competitionId).sort()).toEqual([comp.id, null].sort());

        expect(await position(alice, { competitionId: comp.id })).toMatchObject({ margin_mode: "ISOLATED", base_qty: "-0.10000000" });
        expect((await wallet(alice, btcAssetId, comp.id)).balance).toBe("0.00000000");
        expect((await wallet(alice, usdAssetId, comp.id)).balance).toBe(new Decimal("20000").plus("8300").minus("4.15").minus("16600").toFixed(8));
        expectSameEquity(compBefore, await equityAt(alice, MARKS, comp.id));
        expectSameEquity(freeBefore, await equityAt(alice, MARKS, null));
    });
});

describe("one user at a time", () => {
    it("a failure rolls back only that user (orders included); the others convert; all reported", async () => {
        const alice = await trader();
        const bob = await trader();
        const carol = await trader();
        for (const u of [alice, bob, carol]) await market(u, "BUY", "0.10000000");
        const { order: bobsLimit } = await limit(bob, "BUY", "0.01000000", "80000");

        // Make bob's position write fail (as any DB error mid-conversion would).
        await pool.query(`
            CREATE OR REPLACE FUNCTION test_fail_conversion() RETURNS trigger AS $$
            BEGIN
                IF NEW.user_id = '${bob}'::uuid AND NEW.margin_mode = 'ISOLATED' THEN RAISE EXCEPTION 'boom'; END IF;
                RETURN NEW;
            END $$ LANGUAGE plpgsql;
            CREATE TRIGGER test_fail_conversion BEFORE UPDATE ON positions FOR EACH ROW EXECUTE FUNCTION test_fail_conversion();`);
        try {
            const bobBefore = { usd: await wallet(bob, usdAssetId), btc: await wallet(bob, btcAssetId), pos: await position(bob) };
            const run = await runConversion({ apply: true });
            const status = new Map(run.users.map((u) => [u.userId, u]));
            expect(status.get(alice)!.status).toBe("converted");
            expect(status.get(carol)!.status).toBe("converted");
            expect(status.get(bob)!.status).toBe("failed");
            expect(status.get(bob)!.reason).toContain("boom");
            expect(run.counts).toMatchObject({ converted: 2, failed: 1, blocked: 0 });

            expect({ usd: await wallet(bob, usdAssetId), btc: await wallet(bob, btcAssetId), pos: await position(bob) }).toEqual(bobBefore);
            const { rows: [o] } = await pool.query(`SELECT status FROM orders WHERE id = $1`, [bobsLimit.id]);
            expect(o.status).toBe("OPEN");
            expect(formatRun(run)).toMatch(/failed\s+1/);
        } finally {
            await pool.query(`DROP TRIGGER IF EXISTS test_fail_conversion ON positions; DROP FUNCTION IF EXISTS test_fail_conversion();`);
        }

        // Fixed: the next run converts bob and leaves the others alone.
        const again = await runConversion({ apply: true });
        expect(again.users.map((u) => [u.userId, u.status])).toEqual([[bob, "converted"]]);
    });

    it("--user limits the run to one user", async () => {
        const alice = await trader();
        const bob = await trader();
        for (const u of [alice, bob]) await market(u, "BUY", "0.10000000");
        const run = await runConversion({ apply: true, userId: bob });
        expect(run.users.map((u) => u.userId)).toEqual([bob]);
        expect((await position(alice)).margin_mode).toBe("SPOT");
        expect((await position(bob)).margin_mode).toBe("ISOLATED");
    });
});

// ── Live: same lock order as trading ────────────────────────────────────

describe("while the site is live", () => {
    let alice: string;
    beforeEach(async () => {
        alice = await trader();
        await market(alice, "BUY", "0.10000000");
    });

    async function endState() {
        return { usd: (await wallet(alice, usdAssetId)).balance, btc: (await wallet(alice, btcAssetId)).balance, pos: await position(alice) };
    }

    it("the user's own order queued first: it trades SPOT, the conversion then converts what's left", async () => {
        const release = await holdLock(`SELECT id FROM trading_pairs WHERE id = $1 FOR UPDATE`, [pairId]);
        const sell = market(alice, "SELL", "0.04000000");
        await waitBlocked(1);
        const convert = applyUserConversion(alice);
        await waitBlocked(2);
        await release();
        await sell;
        expect((await convert).status).toBe("converted");
        const s = await endState();
        expect(s.pos).toMatchObject({ base_qty: "0.06000000", margin_mode: "ISOLATED", isolated_margin: "4980.00000000" });
        expect(s.btc).toBe("0.00000000");
        // 91,695.85 + 3,320 − 1.66 fee (spot sell); the long's conversion nets 0 USD.
        expect(s.usd).toBe("95014.19000000");
    });

    it("the conversion queued first: it converts, then the user's order reduces the ISOLATED position, same result", async () => {
        const release = await holdLock(`SELECT id FROM trading_pairs WHERE id = $1 FOR UPDATE`, [pairId]);
        const convert = applyUserConversion(alice);
        await waitBlocked(1);
        const sell = market(alice, "SELL", "0.04000000");
        await waitBlocked(2);
        await release();
        expect((await convert).status).toBe("converted");
        await sell;
        const s = await endState();
        expect(s.pos).toMatchObject({ base_qty: "0.06000000", margin_mode: "ISOLATED", isolated_margin: "4980.00000000" });
        expect(s.btc).toBe("0.00000000");
        // release 3,320 + pnl 0 − 1.66 fee.
        expect(s.usd).toBe("95014.19000000");
    });

    it("a maker fill on the user's resting SPOT order racing the conversion: filled or canceled, never both", async () => {
        const dave = await trader();
        const { order: resting } = await limit(alice, "SELL", "0.04000000", "83000");
        const before = await equityAt(alice, ["83000"]);
        await Promise.all([market(dave, "BUY", "0.04000000"), applyUserConversion(alice)]);
        const { rows: [o] } = await pool.query(`SELECT status, qty_filled::text, cancel_reason FROM orders WHERE id = $1`, [resting.id]);
        const p = await position(alice);
        expect(p.margin_mode).toBe("ISOLATED");
        if (o.status === "FILLED") {
            expect(p.base_qty).toBe("0.06000000");
        } else {
            expect(o).toMatchObject({ status: "CANCELED", qty_filled: "0.00000000", cancel_reason: CONVERSION_CANCEL_REASON });
            expect(p.base_qty).toBe("0.10000000");
        }
        expect((await wallet(alice, btcAssetId)).balance).toBe("0.00000000");
        expect((await wallet(alice, usdAssetId)).reserved).toBe("0.00000000");
        expect((await wallet(alice, btcAssetId)).reserved).toBe("0.00000000");
        if (o.status !== "FILLED") expectSameEquity(before, await equityAt(alice, ["83000"]));
        await noNegativeUsd();
    });

    it("two runs at once: one converts, the other finds nothing to do", async () => {
        const results = await Promise.all([applyUserConversion(alice), applyUserConversion(alice)]);
        expect(results.map((r) => r.status).sort()).toEqual(["converted", "nothing"]);
        expect((await position(alice)).isolated_margin).toBe("8300.00000000");
        const { rows } = await pool.query(
            `SELECT count(*)::int AS n FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id
             WHERE w.user_id = $1 AND l.entry_type = 'MARGIN_LOCK'`, [alice]);
        expect(rows[0].n).toBe(1);
    });

    it("the liquidation engine evaluating at the same time: no deadlock, no liquidation row", async () => {
        const users = [alice];
        for (let i = 0; i < 4; i++) {
            const u = await trader();
            await market(u, i % 2 ? "SELL" : "BUY", "0.05000000");
            users.push(u);
        }
        const engine = new LiquidationEngine({ feedStatus: () => "ok", useLeadership: false });
        const t0 = Date.now();
        const results = await Promise.all([
            ...users.map((u) => applyUserConversion(u)),
            engine.evaluatePair(pairId, t0),
            engine.evaluatePair(pairId, t0 + 600).catch(() => null),
        ]);
        for (const r of results.slice(0, users.length)) expect((r as { status: string }).status).toBe("converted");
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM liquidations`);
        expect(rows[0].n).toBe(0);
        await noNegativeUsd();
    });
});
