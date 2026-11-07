/**
 * matchSettlementFee.test.ts: holding to match end costs what closing does.
 *
 * Match end is a real close (an order and a trade at the close price), but it
 * charged no fee, so holding was cheaper than closing by hand. Same match, same
 * entry, one player closes at X, the other is closed by the match at X: every
 * number must agree. Real wallets, matching engine and match end.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { pool } from "../../db/pool";
import { config } from "../../config";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { placeOrderWithSnapshot } from "../../trading/phase6OrderService";
import { createMatch, acceptMatch, completeMatch, forfeitMatch } from "../matchService";
import { getMatchBreakdown } from "../breakdown/breakdownService";

const QTY = "0.10000000";

let pairId: string;
let btcAssetId: string;
let usdAssetId: string;
let alice: string;
let bob: string;
const saved = { ...config.leverage };

async function trader() {
    const u = await createTestUser(pool);
    await createTestWallets(pool, u.id, btcAssetId, usdAssetId, "0.00000000", "100000.00000000");
    return u.id;
}

async function acceptedMatch() {
    const m = await createMatch(alice, bob, 24, [pairId]);
    await acceptMatch(m.id, bob);
    return m.id;
}

const trade = (uid: string, matchId: string, side: "BUY" | "SELL", leverage?: number) =>
    placeOrderWithSnapshot(uid, { pairId, side, type: "MARKET", qty: QTY, leverage }, undefined, undefined, null, matchId);

/** Everything a player ended the match with. */
async function result(uid: string, matchId: string) {
    const { rows: [pos] } = await pool.query(
        `SELECT base_qty::text, realized_pnl_quote::text, fees_paid_quote::text
         FROM positions WHERE user_id = $1 AND match_id = $2`,
        [uid, matchId],
    );
    const { rows: [usd] } = await pool.query(
        `SELECT balance::text FROM wallets WHERE user_id = $1 AND match_id = $2 AND asset_id = $3`,
        [uid, matchId, usdAssetId],
    );
    const { rows: [m] } = await pool.query(
        `SELECT CASE WHEN challenger_id = $1 THEN challenger_pnl_pct ELSE opponent_pnl_pct END::text AS pnl_pct
         FROM matches WHERE id = $2`,
        [uid, matchId],
    );
    return { ...pos, usd: usd.balance, pnlPct: m.pnl_pct };
}

/** The close's trade row: the last trade on the user's match orders. */
async function closeTrade(uid: string, matchId: string) {
    const { rows } = await pool.query(
        `SELECT t.price::text, t.qty::text, t.quote_amount::text, t.fee_amount::text
         FROM trades t JOIN orders o ON o.id IN (t.buy_order_id, t.sell_order_id)
         WHERE o.user_id = $1 AND o.match_id = $2
         ORDER BY t.executed_at DESC, t.id LIMIT 1`,
        [uid, matchId],
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
    alice = await trader();
    bob = await trader();
});

afterEach(() => {
    Object.assign(config.leverage, saved, { allowlist: [...saved.allowlist] });
});

describe.each([
    ["SPOT", undefined],
    ["ISOLATED", 2],
] as const)("%s: closing by hand and being closed by the match cost the same", (mode, leverage) => {
    beforeEach(() => {
        if (leverage) {
            Object.assign(config.leverage, { enabled: true, maxFreePlay: 10, maxMatch: 5, maxCompetition: 1, allowlist: [] });
        }
    });

    it.each([
        ["long", "BUY", "SELL", "84000"],
        ["short", "SELL", "BUY", "82000"],
    ] as const)("%s: A closes at X, B is auto-closed at X", async (_name, open, close, x) => {
        seedReferenceBook(pairId, "83000", "83000");
        const id = await acceptedMatch();
        await trade(alice, id, open, leverage);
        await trade(bob, id, open, leverage);

        seedReferenceBook(pairId, x, x);
        await placeOrderWithSnapshot(
            alice,
            { pairId, side: close, type: "MARKET", qty: QTY, reduceOnly: true },
            undefined, undefined, null, id,
        );
        await completeMatch(id);

        const manual = await result(alice, id);
        const auto = await result(bob, id);
        expect(auto).toEqual(manual);

        // The trade row carries the fee itself, not just the ledger.
        const autoClose = await closeTrade(bob, id);
        expect(autoClose).toEqual(await closeTrade(alice, id));
        expect(Number(autoClose.fee_amount)).toBeCloseTo(Number(x) * 0.1 * 0.0005, 8);

        // The breakdown's numbers: alice is the challenger, bob the opponent.
        const { challengerSummary, opponentSummary } = await getMatchBreakdown(id);
        expect(opponentSummary.feesQuote).toBe(challengerSummary.feesQuote);
        expect(opponentSummary.netPnlQuote).toBe(challengerSummary.netPnlQuote);
        expect(opponentSummary.realizedPnlQuote).toBe(challengerSummary.realizedPnlQuote);
        expect(opponentSummary.feesQuote).toBe(auto.fees_paid_quote);

        // The close's own fee: 5 bps of the notional, on top of the open's.
        const open5bps = 83000 * 0.1 * 0.0005;
        const close5bps = Number(x) * 0.1 * 0.0005;
        expect(Number(auto.fees_paid_quote)).toBeCloseTo(open5bps + close5bps, 6);
        expect(mode).toBeTruthy();
    });

    it("forfeit closes pay it too", async () => {
        seedReferenceBook(pairId, "83000", "83000");
        const id = await acceptedMatch();
        await trade(alice, id, "BUY", leverage);
        await trade(bob, id, "SELL", leverage);

        seedReferenceBook(pairId, "84000", "84000");
        await forfeitMatch(id, alice);

        for (const uid of [alice, bob]) {
            expect((await closeTrade(uid, id)).fee_amount).toBe("4.20000000");
            expect(Number((await result(uid, id)).fees_paid_quote)).toBeCloseTo(4.15 + 4.2, 6);
        }
    });
});

describe("the fee shows up everywhere the close does", () => {
    it("SPOT: in the headline P&L and the USD wallet, with no extra ledger row", async () => {
        seedReferenceBook(pairId, "83000", "83000");
        const id = await acceptedMatch();
        await trade(alice, id, "BUY");

        seedReferenceBook(pairId, "84000", "84000");
        await completeMatch(id);

        // +100 gross, 4.15 open fee, 4.20 close fee, on 50,000.
        const r = await result(alice, id);
        expect(r.realized_pnl_quote).toBe("100.00000000");
        expect(r.fees_paid_quote).toBe("8.35000000");
        expect(r.usd).toBe("50091.65000000");
        expect(Number(r.pnlPct)).toBeCloseTo(0.1833, 6);

        const { rows } = await pool.query(
            `SELECT l.entry_type, l.amount::text, l.metadata->>'fee' AS fee
             FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id
             WHERE w.user_id = $1 AND w.match_id = $2 AND w.asset_id = $3 AND l.entry_type = 'MATCH_SETTLEMENT'`,
            [alice, id, usdAssetId],
        );
        expect(rows).toEqual([{ entry_type: "MATCH_SETTLEMENT", amount: "8395.80000000", fee: "4.20000000" }]);
    });

    it("no position: no fee", async () => {
        seedReferenceBook(pairId, "83000", "83000");
        const id = await acceptedMatch();
        await completeMatch(id);
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM trades`);
        expect(rows[0].n).toBe(0);
    });

    it("a finished match stays as it was: match end touches only its own match", async () => {
        seedReferenceBook(pairId, "83000", "83000");
        const done = await acceptedMatch();
        await trade(alice, done, "BUY");
        await completeMatch(done);
        const before = await pool.query(`SELECT * FROM matches WHERE id = $1`, [done]);
        const beforePos = await result(alice, done);

        const carol = await trader();
        const dave = await trader();
        const next = await createMatch(carol, dave, 24, [pairId]);
        await acceptMatch(next.id, dave);
        await trade(carol, next.id, "BUY");
        await completeMatch(next.id);

        expect((await pool.query(`SELECT * FROM matches WHERE id = $1`, [done])).rows).toEqual(before.rows);
        expect(await result(alice, done)).toEqual(beforePos);
    });
});
