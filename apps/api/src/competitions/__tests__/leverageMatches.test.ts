/**
 * leverageMatches.test.ts: 1v1 matches on the ISOLATED model (leverage PR 3,
 * docs/designs/2026-10-13-leverage-design.md §1 "Matches", §5).
 *
 *   accept     stamps matches.margin_mode + max_leverage: ISOLATED at
 *              LEVERAGE_MAX_MATCH while LEVERAGE_ENABLED is on, SPOT at 1x
 *              (the column defaults, as before) while it's off.
 *   trading    the stamp decides the model for the whole match, whatever
 *              the flag says later (off → the stamped ISOLATED match trades
 *              at 1x, the kill switch).
 *   match end  an open ISOLATED position settles like a close at the fair
 *              touch: margin released, P&L booked with the loss cap (a gap
 *              past bankruptcy loses the margin, never more), no base moved.
 *   live P&L   unrealized on an ISOLATED row is capped at −margin.
 *   scoring    unchanged formula; a P&L beyond ±50% logs score_pnl_clamped.
 *
 * Real Postgres; real acceptMatch / order pipeline / match-end paths.
 * BTC/USD: taker 5 bps, maintenance margin 50 bps. ROOKIE capital $50,000.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

const logged = vi.hoisted(() => [] as { msg: string; obj: Record<string, unknown> }[]);

vi.mock("../../notifications/notificationService", () => ({
    notifyTriggerFired: vi.fn().mockResolvedValue(undefined),
}));

// Capture info logs from module loggers (matchService's score_pnl_clamped).
vi.mock("../../observability/logContext", async (importOriginal) => {
    const real = await importOriginal<typeof import("../../observability/logContext")>();
    type Loose = { child: (...a: unknown[]) => Loose; info: (o: unknown, m?: string) => void };
    const wrap = (l: Loose): Loose => new Proxy(l, {
        get(target, prop, recv) {
            if (prop === "child") return (...args: unknown[]) => wrap(target.child(...args));
            if (prop === "info") {
                return (obj: unknown, msg?: string) => {
                    if (typeof msg === "string") logged.push({ msg, obj: obj as Record<string, unknown> });
                    return target.info(obj, msg);
                };
            }
            return Reflect.get(target, prop, recv);
        },
    });
    return { ...real, logger: wrap(real.logger as unknown as Loose) as unknown as typeof real.logger };
});

const published = vi.hoisted(() => [] as { type: string; data: Record<string, unknown> }[]);
vi.mock("../../events/matchEvents", async (importOriginal) => {
    const real = await importOriginal<typeof import("../../events/matchEvents")>();
    return {
        ...real,
        publishMatchEvent: (type: string, data: Record<string, unknown>, ...rest: unknown[]) => {
            published.push({ type, data });
            return (real.publishMatchEvent as (...a: unknown[]) => unknown)(type, data, ...rest);
        },
    };
});

import Decimal from "decimal.js";
import { pool } from "../../db/pool";
import { config } from "../../config";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { placeOrderWithSnapshot } from "../../trading/phase6OrderService";
import { createMatch, acceptMatch, completeMatch, forfeitMatch } from "../matchService";
import { evaluateMatchPnlForPair } from "../matchPnlEngine";

let pairId: string;
let btcAssetId: string;
let usdAssetId: string;
let alice: string;
let bob: string;

const CAPITAL = new Decimal("50000");
const savedLeverage = { ...config.leverage };

function enableLeverage(overrides: Partial<typeof config.leverage> = {}) {
    Object.assign(config.leverage, {
        enabled: true, maxFreePlay: 10, maxMatch: 5, maxCompetition: 1, allowlist: [], ...overrides,
    });
}

async function trader() {
    const u = await createTestUser(pool);
    await createTestWallets(pool, u.id, btcAssetId, usdAssetId, "0.00000000", "100000.00000000");
    return u.id;
}

async function acceptedMatch(): Promise<string> {
    const m = await createMatch(alice, bob, 24, [pairId]);
    await acceptMatch(m.id, bob);
    return m.id;
}

const inMatch = (uid: string, matchId: string, side: "BUY" | "SELL", qty: string, leverage?: number) =>
    placeOrderWithSnapshot(uid, { pairId, side, type: "MARKET", qty, leverage }, undefined, undefined, null, matchId);

async function matchRow(id: string) {
    const { rows } = await pool.query<{
        margin_mode: string; max_leverage: string; challenger_pnl_pct: string | null; opponent_pnl_pct: string | null;
    }>(
        `SELECT margin_mode, max_leverage::text, challenger_pnl_pct::text, opponent_pnl_pct::text FROM matches WHERE id = $1`,
        [id],
    );
    return rows[0];
}

async function balance(uid: string, assetId: string, matchId: string | null) {
    const { rows } = await pool.query<{ balance: string; reserved: string; closed_at: string | null }>(
        `SELECT balance::text, reserved::text, closed_at::text FROM wallets
         WHERE user_id = $1 AND asset_id = $2 AND competition_id IS NULL AND match_id IS NOT DISTINCT FROM $3`,
        [uid, assetId, matchId],
    );
    return rows[0];
}

async function position(uid: string, matchId: string) {
    const { rows } = await pool.query<{
        base_qty: string; realized_pnl_quote: string; fees_paid_quote: string;
        margin_mode: string; leverage: string; isolated_margin: string; liq_price: string | null; opened_at: string | null;
    }>(
        `SELECT base_qty::text, realized_pnl_quote::text, fees_paid_quote::text, margin_mode, leverage::text,
                isolated_margin::text, liq_price::text, opened_at::text
         FROM positions WHERE user_id = $1 AND pair_id = $2 AND match_id = $3`,
        [uid, pairId, matchId],
    );
    return rows[0];
}

async function usdLedger(uid: string, matchId: string): Promise<[string, string][]> {
    const { rows } = await pool.query<{ entry_type: string; amount: string }>(
        `SELECT le.entry_type, le.amount::text FROM ledger_entries le
         JOIN wallets w ON w.id = le.wallet_id
         WHERE w.user_id = $1 AND w.match_id = $2 AND w.asset_id = $3
         ORDER BY le.created_at, le.ctid`,
        [uid, matchId, usdAssetId],
    );
    return rows.map((r) => [r.entry_type, r.amount]);
}

const pct = (usdAfter: Decimal) => usdAfter.minus(CAPITAL).div(CAPITAL).mul(100).toNumber();

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    await resetTestData();
    clearReferenceBooks();
    logged.length = 0;
    published.length = 0;
    const assets = await createTestAssetAndPair(pool);
    pairId = assets.pair.id;
    btcAssetId = assets.btcAsset.id;
    usdAssetId = assets.usdAsset.id;
    alice = await trader();
    bob = await trader();
    seedReferenceBook(pairId, "83000", "83000");
});

afterEach(() => {
    Object.assign(config.leverage, savedLeverage);
});

describe("stamp at accept", () => {
    it("flag off: SPOT at 1x, the column defaults (unchanged)", async () => {
        const id = await acceptedMatch();
        expect(await matchRow(id)).toMatchObject({ margin_mode: "SPOT", max_leverage: "1.00" });
    });

    it("flag on: ISOLATED at LEVERAGE_MAX_MATCH, and a later cap change doesn't touch it", async () => {
        enableLeverage({ maxMatch: 5 });
        const id = await acceptedMatch();
        expect(await matchRow(id)).toMatchObject({ margin_mode: "ISOLATED", max_leverage: "5.00" });

        config.leverage.maxMatch = 2;
        expect((await matchRow(id)).max_leverage).toBe("5.00");
        await inMatch(alice, id, "BUY", "0.10000000", 5);
        expect(Number((await position(alice, id)).leverage)).toBe(5);
    });

    it("a PENDING match is not stamped until accepted (the cap in force at accept wins)", async () => {
        enableLeverage({ maxMatch: 3 });
        const m = await createMatch(alice, bob, 24, [pairId]);
        expect(await matchRow(m.id)).toMatchObject({ margin_mode: "SPOT", max_leverage: "1.00" });
        config.leverage.maxMatch = 4;
        await acceptMatch(m.id, bob);
        expect(await matchRow(m.id)).toMatchObject({ margin_mode: "ISOLATED", max_leverage: "4.00" });
    });
});

describe("the stamp decides the model for the whole match", () => {
    it("an ISOLATED match: margin out of the match USD wallet, no base, cap = the stamp", async () => {
        enableLeverage();
        const id = await acceptedMatch();

        await expect(inMatch(alice, id, "BUY", "0.10000000", 6)).rejects.toThrow(/leverage_exceeds_cap/);
        await inMatch(alice, id, "BUY", "0.10000000", 5);

        // 0.1 × 83,000 = 8,300 notional → 1,660 margin + 4.15 fee.
        const p = await position(alice, id);
        expect(p).toMatchObject({ margin_mode: "ISOLATED", leverage: "5.00", isolated_margin: "1660.00000000" });
        expect((await balance(alice, usdAssetId, id)).balance).toBe(CAPITAL.minus("1664.15").toFixed(8));
        expect((await balance(alice, btcAssetId, id)).balance).toBe("0.00000000");
        expect((await balance(alice, usdAssetId, null)).balance).toBe("100000.00000000");
    });

    it("flag turned off mid-match: the ISOLATED match keeps trading ISOLATED, at 1x", async () => {
        enableLeverage();
        const id = await acceptedMatch();
        config.leverage.enabled = false;

        await expect(inMatch(alice, id, "BUY", "0.10000000", 2)).rejects.toThrow(/leverage_exceeds_cap/);
        await inMatch(alice, id, "BUY", "0.10000000");
        const p = await position(alice, id);
        expect(p).toMatchObject({ margin_mode: "ISOLATED", leverage: "1.00", isolated_margin: "8300.00000000" });
        expect((await balance(alice, btcAssetId, id)).balance).toBe("0.00000000");
    });

    it("a match accepted while the flag was off stays SPOT after it's turned on", async () => {
        const id = await acceptedMatch();
        enableLeverage();

        await inMatch(alice, id, "BUY", "0.10000000");
        expect((await position(alice, id)).margin_mode).toBe("SPOT");
        expect((await balance(alice, btcAssetId, id)).balance).toBe("0.10000000");
    });
});

describe("match end settles ISOLATED positions with the loss cap", () => {
    it("complete: long in profit and short in loss close at the fair touch", async () => {
        enableLeverage();
        const id = await acceptedMatch();
        await inMatch(alice, id, "BUY", "0.10000000", 5);
        await inMatch(bob, id, "SELL", "0.10000000", 5);

        seedReferenceBook(pairId, "84000", "84000");
        await completeMatch(id);

        // Long: +0.1 × 1,000 = +100. Short: −100. Margin back, no close fee
        // (the force-close is fee-free, as for SPOT matches).
        const aliceUsd = CAPITAL.minus("1664.15").plus("1660").plus("100");
        const bobUsd = CAPITAL.minus("1664.15").plus("1660").minus("100");
        expect((await balance(alice, usdAssetId, id)).balance).toBe(aliceUsd.toFixed(8));
        expect((await balance(bob, usdAssetId, id)).balance).toBe(bobUsd.toFixed(8));
        expect(await usdLedger(alice, id)).toEqual([
            ["MATCH_FUNDING", "50000.00000000"],
            ["MARGIN_LOCK", "-1660.00000000"],
            ["FEE", "-4.15000000"],
            ["MARGIN_RELEASE", "1660.00000000"],
            ["REALIZED_PNL", "100.00000000"],
        ]);

        for (const uid of [alice, bob]) {
            const p = await position(uid, id);
            expect(p).toMatchObject({ base_qty: "0.00000000", isolated_margin: "0.00000000", liq_price: null, opened_at: null });
            expect((await balance(uid, btcAssetId, id)).balance).toBe("0.00000000");
            expect((await balance(uid, usdAssetId, id)).closed_at).not.toBeNull();
        }

        // Score = wallet P&L = positions' realized − fees.
        const m = await matchRow(id);
        expect(Number(m.challenger_pnl_pct)).toBeCloseTo(pct(aliceUsd), 6);
        expect(Number(m.opponent_pnl_pct)).toBeCloseTo(pct(bobUsd), 6);

        // The synthetic close order is recorded on the position's model.
        const { rows: closes } = await pool.query<{ margin_mode: string; leverage: string; side: string }>(
            `SELECT o.margin_mode, o.leverage::text, o.side FROM orders o
             JOIN trades t ON t.buy_order_id = o.id OR t.sell_order_id = o.id
             WHERE o.match_id = $1 AND t.is_system_fill AND o.reserved_amount = 0 AND o.user_id = $2
             ORDER BY t.executed_at DESC LIMIT 1`,
            [id, alice],
        );
        expect(closes[0]).toEqual({ margin_mode: "ISOLATED", leverage: "5.00", side: "SELL" });
    });

    it("a gap past bankruptcy loses the margin, never more; the score uses the capped loss", async () => {
        enableLeverage();
        const id = await acceptedMatch();
        await inMatch(alice, id, "BUY", "0.10000000", 5);

        // Bankruptcy 83,000 × 0.8 = 66,400. At 60,000 the raw loss is 2,300.
        seedReferenceBook(pairId, "60000", "60000");
        await completeMatch(id);

        const usd = CAPITAL.minus("1664.15");
        expect((await balance(alice, usdAssetId, id)).balance).toBe(usd.toFixed(8));
        const ledger = await usdLedger(alice, id);
        expect(ledger.slice(3)).toEqual([
            ["MARGIN_RELEASE", "1660.00000000"],
            ["REALIZED_PNL", "-1660.00000000"],
            ["LIQUIDATION_SHORTFALL", "0.00000000"],
        ]);
        const { rows: [sf] } = await pool.query<{ shortfall: string }>(
            `SELECT le.metadata->>'shortfall' AS shortfall FROM ledger_entries le JOIN wallets w ON w.id = le.wallet_id
             WHERE w.match_id = $1 AND le.entry_type = 'LIQUIDATION_SHORTFALL'`, [id]);
        expect(sf.shortfall).toBe("640.00000000");

        expect((await position(alice, id)).realized_pnl_quote).toBe("-1660.00000000");
        expect(Number((await matchRow(id)).challenger_pnl_pct)).toBeCloseTo(pct(usd), 6);
    });

    it("forfeit settles the same way (the forfeiter's loss sticks, capped)", async () => {
        enableLeverage();
        const id = await acceptedMatch();
        await inMatch(bob, id, "SELL", "0.10000000", 5);

        // Short bankruptcy 83,000 × 1.2 = 99,600; at 110,000 the raw loss is 2,700.
        seedReferenceBook(pairId, "110000", "110000");
        await forfeitMatch(id, bob);

        const usd = CAPITAL.minus("1664.15");
        expect((await balance(bob, usdAssetId, id)).balance).toBe(usd.toFixed(8));
        expect(await position(bob, id)).toMatchObject({ base_qty: "0.00000000", isolated_margin: "0.00000000" });
        expect(Number((await matchRow(id)).opponent_pnl_pct)).toBeCloseTo(pct(usd), 6);
    });

    it("logs score_pnl_clamped when a player's P&L is beyond ±50%", async () => {
        enableLeverage();
        const id = await acceptedMatch();
        // 2.5 BTC at 5x: 41,500 margin. Wiped by a gap: −41,603.75 = −83%.
        await inMatch(alice, id, "BUY", "2.50000000", 5);
        await inMatch(bob, id, "BUY", "0.01000000", 5);
        seedReferenceBook(pairId, "60000", "60000");
        await completeMatch(id);

        const clamped = logged.filter((l) => l.msg === "score_pnl_clamped");
        expect(clamped).toHaveLength(1);
        expect(clamped[0].obj).toMatchObject({ matchId: id, userId: alice });
        expect(clamped[0].obj.pnlPct as number).toBeCloseTo(-83.2075, 4);
    });
});

describe("live match P&L", () => {
    it("caps an ISOLATED position's unrealized loss at its margin", async () => {
        enableLeverage();
        const id = await acceptedMatch();
        await inMatch(alice, id, "BUY", "0.10000000", 5);

        // The live push prices off the snapshot / last_price, not the book.
        await pool.query(`UPDATE trading_pairs SET last_price = 60000 WHERE id = $1`, [pairId]);
        await evaluateMatchPnlForPair(pairId);

        const push = published.filter((e) => e.type === "match.pnl.update").at(-1)!;
        // −1,660 margin − 4.15 fee, not −2,300 − 4.15.
        expect(Number(push.data.challengerPnlPct)).toBeCloseTo(pct(CAPITAL.minus("1664.15")), 6);
    });
});
