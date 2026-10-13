/**
 * matchWallets.test.ts — a 1v1 match trades its own wallets (migration 095).
 *
 * Before: wallets.match_id was never set. Match orders traded the players'
 * free-play wallets, starting_capital wasn't enforced, a match short counted
 * against free-play buying power, and the match-end force-close only rewrote
 * positions, so every ended match left its footprint in free-play.
 *
 * Now: acceptMatch funds per-match wallets (USD = starting_capital), every
 * match order trades them, and each of the 4 end paths cancels the match's
 * open orders, settles the wallets to USD at the fair close price (long at
 * the bid, short at the ask) and closes them. Nothing moves to free-play.
 *
 * Real Postgres; real acceptMatch / matching engine / match-end paths.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

vi.mock("../../notifications/notificationService", () => ({
    notifyTriggerFired: vi.fn().mockResolvedValue(undefined),
}));

import { pool } from "../../db/pool";
import { config } from "../../config";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { placeOrderWithSnapshot } from "../../trading/phase6OrderService";
import {
    createMatch,
    acceptMatch,
    completeMatch,
    forfeitMatch,
    mutualForfeitMatch,
    cancelActiveMatch,
} from "../matchService";

let pairId: string;
let btcAssetId: string;
let usdAssetId: string;
let alice: string;
let bob: string;

const FREE_USD = "100000.00000000";

async function trader(email?: string) {
    const u = await createTestUser(pool, email ? { email } : {});
    await createTestWallets(pool, u.id, btcAssetId, usdAssetId, "0.00000000", FREE_USD);
    return u.id;
}

/** A match accepted through the real acceptMatch (which funds the wallets). */
async function activeMatch(): Promise<{ id: string; capital: number }> {
    const m = await createMatch(alice, bob, 24, [pairId]);
    await acceptMatch(m.id, bob);
    const { rows } = await pool.query<{ starting_capital: string }>(`SELECT starting_capital::text FROM matches WHERE id = $1`, [m.id]);
    return { id: m.id, capital: Number(rows[0].starting_capital) };
}

const inMatch = (uid: string, matchId: string, side: "BUY" | "SELL", qty: string, type: "MARKET" | "LIMIT" = "MARKET", limitPrice?: string) =>
    placeOrderWithSnapshot(uid, { pairId, side, type, qty, limitPrice }, undefined, undefined, null, matchId);
const freePlay = (uid: string, side: "BUY" | "SELL", qty: string) =>
    placeOrderWithSnapshot(uid, { pairId, side, type: "MARKET", qty });

type W = { id: string; balance: number; reserved: number; closed_at: string | null };
/** A user's wallet for an asset: free-play when matchId is null. */
async function wallet(uid: string, assetId: string, matchId: string | null = null): Promise<W | undefined> {
    const { rows } = await pool.query<{ id: string; balance: string; reserved: string; closed_at: string | null }>(
        `SELECT id, balance::text, reserved::text, closed_at::text FROM wallets
         WHERE user_id = $1 AND asset_id = $2 AND competition_id IS NULL
           AND match_id IS NOT DISTINCT FROM $3`,
        [uid, assetId, matchId],
    );
    const r = rows[0];
    return r && { id: r.id, balance: Number(r.balance), reserved: Number(r.reserved), closed_at: r.closed_at };
}
const freeUsd = async (uid: string) => (await wallet(uid, usdAssetId))!.balance;
const freeBtc = async (uid: string) => (await wallet(uid, btcAssetId))!.balance;

async function openOrders(matchId: string) {
    const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM orders WHERE match_id = $1 AND status IN ('OPEN', 'PARTIALLY_FILLED')`, [matchId]);
    return rows[0].n;
}

/** Match USD − capital vs Σ(realized − fees) over the player's match positions. */
async function pnlCheck(uid: string, matchId: string, capital: number) {
    const usd = (await wallet(uid, usdAssetId, matchId))!.balance;
    const { rows } = await pool.query<{ net: string }>(
        `SELECT COALESCE(SUM(realized_pnl_quote - fees_paid_quote), 0)::text AS net
         FROM positions WHERE match_id = $1 AND user_id = $2`, [matchId, uid]);
    return { walletPnl: usd - capital, positionsPnl: Number(rows[0].net) };
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
    alice = await trader();
    bob = await trader();
    seedReferenceBook(pairId, "50000", "50000");
});

describe("funding at accept", () => {
    it("PENDING has no wallets; accept funds both players with starting_capital (new money)", async () => {
        const m = await createMatch(alice, bob, 24, [pairId]);
        expect(await wallet(alice, usdAssetId, m.id)).toBeUndefined();

        await acceptMatch(m.id, bob);
        const { rows: [match] } = await pool.query<{ starting_capital: string }>(`SELECT starting_capital::text FROM matches WHERE id = $1`, [m.id]);
        for (const uid of [alice, bob]) {
            expect((await wallet(uid, usdAssetId, m.id))!.balance).toBe(Number(match.starting_capital));
            expect((await wallet(uid, btcAssetId, m.id))!.balance).toBe(0);
            expect(await freeUsd(uid)).toBe(100000); // not taken from free-play
        }
        const { rows: ledger } = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM ledger_entries le JOIN wallets w ON w.id = le.wallet_id
             WHERE w.match_id = $1 AND le.entry_type = 'MATCH_FUNDING'`, [m.id]);
        expect(ledger[0].n).toBe(2);
    });
});

describe("match fills trade the match wallets", () => {
    it("never touch free-play", async () => {
        const { id, capital } = await activeMatch();
        await inMatch(alice, id, "BUY", "0.10000000");

        expect((await wallet(alice, btcAssetId, id))!.balance).toBe(0.1);
        expect((await wallet(alice, usdAssetId, id))!.balance).toBeLessThan(capital - 5000);
        expect(await freeUsd(alice)).toBe(100000);
        expect(await freeBtc(alice)).toBe(0);
    });

    it("starting_capital is the cap, whatever free-play holds", async () => {
        const { id, capital } = await activeMatch();
        const tooBig = ((capital * 1.2) / 50000).toFixed(8); // 120% of the match capital, < free-play's 100k
        await expect(inMatch(alice, id, "BUY", tooBig)).rejects.toThrow(/insufficient_balance/);
        expect(await freeUsd(alice)).toBe(100000);
    });

    it("isolation: a match short never reduces free-play buying power", async () => {
        const { id, capital } = await activeMatch();
        await inMatch(alice, id, "SELL", ((capital * 0.4) / 50000).toFixed(8)); // short 40% of the match capital
        // Free-play still has its full 100k: a $99k free-play long fills.
        await freePlay(alice, "BUY", "1.98000000");
        expect(await freeBtc(alice)).toBe(1.98);
    });

    it("isolation: a free-play short never reduces match buying power", async () => {
        const { id, capital } = await activeMatch();
        await freePlay(alice, "SELL", "0.90000000"); // $45k free-play short
        const almostAll = ((capital * 0.98) / 50000).toFixed(8);
        await inMatch(alice, id, "BUY", almostAll);
        expect((await wallet(alice, btcAssetId, id))!.balance).toBe(Number(almostAll));
    });

    it("a resting match order filled by a free-play taker settles in the maker's match wallets", async () => {
        const { id } = await activeMatch();
        const outsider = await trader();
        await inMatch(alice, id, "SELL", "0.05000000", "LIMIT", "50000"); // resting short in the match
        await freePlay(outsider, "BUY", "0.05000000");

        expect((await wallet(alice, btcAssetId, id))!.balance).toBe(-0.05);
        expect(await freeBtc(alice)).toBe(0);
        expect(await freeUsd(alice)).toBe(100000);
        expect(await freeBtc(outsider)).toBe(0.05);
    });
});

describe("competition wallets are untouched by this change", () => {
    it("a competition order still trades that competition's wallets — not free-play, not a match", async () => {
        const { rows: [comp] } = await pool.query<{ id: string }>(
            `INSERT INTO competitions (name, start_at, end_at) VALUES ('c', now(), now() + interval '1 day') RETURNING id`);
        const insert = (assetId: string, balance: string) => pool.query(
            `INSERT INTO wallets (user_id, asset_id, balance, reserved, competition_id) VALUES ($1, $2, $3, 0, $4)`,
            [alice, assetId, balance, comp.id]);
        await insert(usdAssetId, "20000");
        await insert(btcAssetId, "0");
        const { id: matchId } = await activeMatch(); // a live match on the side must not interfere

        await placeOrderWithSnapshot(alice, { pairId, side: "BUY", type: "MARKET", qty: "0.10000000" }, undefined, undefined, comp.id, null);

        const { rows } = await pool.query<{ symbol: string; balance: string }>(
            `SELECT a.symbol, w.balance::text FROM wallets w JOIN assets a ON a.id = w.asset_id
             WHERE w.user_id = $1 AND w.competition_id = $2`, [alice, comp.id]);
        const bal = Object.fromEntries(rows.map((r) => [r.symbol, Number(r.balance)]));
        expect(bal.BTC).toBe(0.1);
        expect(bal.USD).toBeCloseTo(20000 - 5000 - 2.5, 6);
        expect(await freeUsd(alice)).toBe(100000);
        expect((await wallet(alice, btcAssetId, matchId))!.balance).toBe(0);
    });
});

describe("bot as maker", () => {
    it("a match taker hitting the MM bot: match wallets for the taker, free-play for the bot", async () => {
        await pool.query(
            `INSERT INTO users (id, email, email_normalized, password_hash, role)
             VALUES ($1, 'mmbot@system.local', 'mmbot@system.local', 'x', 'USER') ON CONFLICT (id) DO NOTHING`,
            [config.botUserId],
        );
        await createTestWallets(pool, config.botUserId, btcAssetId, usdAssetId, "10.00000000", "1000000.00000000");
        await placeOrderWithSnapshot(config.botUserId, { pairId, side: "SELL", type: "LIMIT", qty: "0.20000000", limitPrice: "50000" });

        const { id, capital } = await activeMatch();
        const res = await inMatch(alice, id, "BUY", "0.20000000");
        expect(res.fills.length).toBeGreaterThan(0);

        expect((await wallet(alice, btcAssetId, id))!.balance).toBe(0.2);
        expect((await wallet(alice, usdAssetId, id))!.balance).toBeCloseTo(capital - 10000 - 10000 * 5 / 10000, 6);
        expect(await freeUsd(alice)).toBe(100000);
        expect((await wallet(config.botUserId, btcAssetId))!.balance).toBe(9.8);
        expect((await wallet(config.botUserId, usdAssetId))!.balance).toBeGreaterThan(1000000);
        const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM wallets WHERE user_id = $1 AND match_id IS NOT NULL`, [config.botUserId]);
        expect(rows[0].n).toBe(0);
    });
});

describe("match end: every path cancels orders, settles and closes the wallets", () => {
    /** Alice long 0.1 + a resting bid; Bob short 0.1 + a resting ask. */
    async function tradedMatch() {
        const m = await activeMatch();
        await inMatch(alice, m.id, "BUY", "0.10000000");
        await inMatch(bob, m.id, "SELL", "0.10000000");
        await inMatch(alice, m.id, "BUY", "0.01000000", "LIMIT", "40000");
        await inMatch(bob, m.id, "SELL", "0.01000000", "LIMIT", "60000");
        expect(await openOrders(m.id)).toBe(2);
        return m;
    }

    async function expectSettledAndClosed(matchId: string) {
        expect(await openOrders(matchId)).toBe(0);
        const { rows } = await pool.query<{ asset: string; balance: string; reserved: string; closed_at: string | null }>(
            `SELECT a.symbol AS asset, w.balance::text, w.reserved::text, w.closed_at::text
             FROM wallets w JOIN assets a ON a.id = w.asset_id WHERE w.match_id = $1`, [matchId]);
        expect(rows.length).toBe(4);
        for (const w of rows) {
            expect(w.closed_at).not.toBeNull();
            expect(Number(w.reserved)).toBe(0);
            if (w.asset !== "USD") expect(Number(w.balance)).toBe(0);
        }
        // Free-play untouched by the whole match.
        for (const uid of [alice, bob]) {
            expect(await freeUsd(uid)).toBe(100000);
            expect(await freeBtc(uid)).toBe(0);
        }
    }

    it("completeMatch", async () => {
        const m = await tradedMatch();
        await completeMatch(m.id);
        await expectSettledAndClosed(m.id);
    });

    it("forfeitMatch", async () => {
        const m = await tradedMatch();
        await forfeitMatch(m.id, alice);
        await expectSettledAndClosed(m.id);
    });

    it("mutualForfeitMatch (no fills; resting orders only)", async () => {
        const m = await activeMatch();
        await inMatch(alice, m.id, "BUY", "0.01000000", "LIMIT", "40000");
        await mutualForfeitMatch(m.id);
        await expectSettledAndClosed(m.id);
        expect((await wallet(alice, usdAssetId, m.id))!.balance).toBe(m.capital);
    });

    it("cancelActiveMatch (no fills; resting orders only)", async () => {
        const m = await activeMatch();
        await inMatch(bob, m.id, "SELL", "0.01000000", "LIMIT", "60000");
        await cancelActiveMatch(alice);
        await expectSettledAndClosed(m.id);
        expect((await wallet(bob, usdAssetId, m.id))!.balance).toBe(m.capital);
    });

    it("an order for an ended match is rejected (match_ended), and free-play is untouched", async () => {
        const m = await tradedMatch();
        await completeMatch(m.id);
        await expect(inMatch(alice, m.id, "BUY", "0.01000000")).rejects.toThrow(/match_ended/);
        expect(await freeUsd(alice)).toBe(100000);
    });
});

describe("scoring and settlement price", () => {
    it("completeMatch picks the right winner, and match USD − capital = realized − fees", async () => {
        const m = await activeMatch();
        await inMatch(alice, m.id, "BUY", "0.10000000"); // long at 50k
        await inMatch(bob, m.id, "SELL", "0.10000000"); // short at 50k
        seedReferenceBook(pairId, "55000", "55100"); // price up: Alice wins
        await inMatch(alice, m.id, "SELL", "0.05000000"); // realize half at the 55k bid

        await completeMatch(m.id);

        const { rows: [done] } = await pool.query<{ winner_id: string; challenger_pnl_pct: string; opponent_pnl_pct: string; status: string }>(
            `SELECT winner_id, challenger_pnl_pct::text, opponent_pnl_pct::text, status FROM matches WHERE id = $1`, [m.id]);
        expect(done.status).toBe("COMPLETED");
        expect(done.winner_id).toBe(alice);
        expect(Number(done.challenger_pnl_pct)).toBeGreaterThan(0);
        expect(Number(done.opponent_pnl_pct)).toBeLessThan(0);

        for (const uid of [alice, bob]) {
            const { walletPnl, positionsPnl } = await pnlCheck(uid, m.id, m.capital);
            expect(walletPnl).toBeCloseTo(positionsPnl, 6);
        }
        // The stored pnl% is the match wallets' result.
        const { walletPnl } = await pnlCheck(alice, m.id, m.capital);
        expect(Number(done.challenger_pnl_pct)).toBeCloseTo((walletPnl / m.capital) * 100, 6);
    });

    it("force-close books a long at the bid and a short at the ask, not the last trade", async () => {
        const m = await activeMatch();
        await inMatch(alice, m.id, "BUY", "0.10000000");
        await inMatch(bob, m.id, "SELL", "0.10000000");
        seedReferenceBook(pairId, "51000", "51200");
        await pool.query(`UPDATE trading_pairs SET last_price = '90000' WHERE id = $1`, [pairId]); // a bad print

        await completeMatch(m.id);

        const { rows } = await pool.query<{ user_id: string; amount: string; price: string }>(
            `SELECT w.user_id, le.amount::text, le.metadata->>'price' AS price
             FROM ledger_entries le JOIN wallets w ON w.id = le.wallet_id
             JOIN assets a ON a.id = w.asset_id AND a.symbol = 'USD'
             WHERE w.match_id = $1 AND le.entry_type = 'MATCH_SETTLEMENT'`, [m.id]);
        const byUser = new Map(rows.map((r) => [r.user_id, r]));
        expect(Number(byUser.get(alice)!.price)).toBe(51000); // long sells at the bid
        expect(Number(byUser.get(alice)!.amount)).toBeCloseTo(5100, 6);
        expect(Number(byUser.get(bob)!.price)).toBe(51200); // short buys at the ask
        expect(Number(byUser.get(bob)!.amount)).toBeCloseTo(-5120, 6);

        // The score was booked at the same prices.
        for (const uid of [alice, bob]) {
            const { walletPnl, positionsPnl } = await pnlCheck(uid, m.id, m.capital);
            expect(walletPnl).toBeCloseTo(positionsPnl, 6);
        }
    });
});
