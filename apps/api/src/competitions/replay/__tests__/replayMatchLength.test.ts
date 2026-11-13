/**
 * Replay of a real match, any length. Prod (Bertito vs berto, Nov 9): a full
 * 15-minute match showed ONE price candle and both P&L lines flat at 0.00,
 * never reaching the finals (-0.04% / -0.02%) and showing no fees.
 *
 * The match is played through the real engine (accept, market + limit orders
 * in match scope, one fill between the players, completeMatch closes what's
 * open), then its fills are moved onto a fixed timeline so the match lasts
 * 15 minutes or 24 hours. Candles are seeded at 1m, 5m and 1h over the whole
 * window, as prod stores them.
 *
 * The replay must:
 *   - pick the candle size from the match length (15m → 1m candles, 24h → 1h),
 *     so the chart has about one candle per minute / hour of the match;
 *   - put a point on the curve at every fill, fees included;
 *   - end each player's curve on the stored headline P&L at the match end.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { vi } from "vitest";

vi.mock("../../../notifications/notificationService", () => ({
    notifyTriggerFired: vi.fn().mockResolvedValue(undefined),
}));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../app";
import { pool } from "../../../db/pool";
import { ensureMigrations, resetTestData } from "../../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../../testing/referenceBook";
import { allowSymbolForTest } from "../../../market/marketSymbols";
import { placeOrderWithSnapshot } from "../../../trading/phase6OrderService";
import { createMatch, acceptMatch, completeMatch } from "../../matchService";

const MIN = 60_000;
const HOUR = 60 * MIN;
const BASE = Date.parse("2026-06-01T00:00:00Z");
/** Anything executed after this ran live in the test; anything before was moved onto the timeline. */
const LIVE_AFTER = new Date("2026-07-01T00:00:00Z");

interface Case {
    label: string;
    durationMs: number;
    /** When each step's fills land, as an offset from the match start. */
    at: (step: number) => number;
    timeframe: string;
    candles: number;
}

const CASES: Case[] = [
    { label: "a 15-minute match", durationMs: 15 * MIN, at: (s) => [1, 3, 6, 10][s]! * MIN, timeframe: "1m", candles: 15 },
    { label: "a 24-hour match", durationMs: 24 * HOUR, at: (s) => [1, 3, 6, 10][s]! * HOUR + 7 * MIN, timeframe: "1h", candles: 24 },
];

describe.each(CASES)("GET /v1/matches/:id/replay, $label", (c) => {
    let app: FastifyInstance;
    let pairId: string;
    let alice: string;
    let bob: string;
    let matchId: string;
    const END = BASE + c.durationMs;

    const auth = (sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` });
    const replay = () => app.inject({ method: "GET", url: `/v1/matches/${matchId}/replay`, headers: auth(alice) });
    const mkt = (uid: string, side: "BUY" | "SELL", qty: string) =>
        placeOrderWithSnapshot(uid, { pairId, side, type: "MARKET", qty }, undefined, undefined, null, matchId);
    const lim = (uid: string, side: "BUY" | "SELL", qty: string, px: string) =>
        placeOrderWithSnapshot(uid, { pairId, side, type: "LIMIT", qty, limitPrice: px }, undefined, undefined, null, matchId);
    /** Move the fills that just ran onto the match timeline. */
    const landAt = (ms: number) =>
        pool.query(`UPDATE trades SET executed_at = $1 WHERE pair_id = $2 AND executed_at > $3`, [new Date(ms), pairId, LIVE_AFTER]);

    async function seedCandles(timeframe: string, stepMs: number) {
        const values: string[] = [];
        const params: unknown[] = [pairId, timeframe];
        let i = 3;
        for (let ts = BASE - 2 * HOUR; ts <= END + 2 * HOUR; ts += stepMs, i++) {
            // A rising price so open positions mark to something other than their entry.
            const px = 83000 + ((ts - BASE) / HOUR) * 40;
            values.push(`($1,$2,$${i},${px},${px + 30},${px - 30},${px + 10},1)`);
            params.push(new Date(ts));
        }
        await pool.query(
            `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume) VALUES ${values.join(",")}`,
            params,
        );
    }

    beforeAll(async () => {
        await ensureMigrations();
        app = await buildApp({
            logger: false, disableKrakenFeed: true, disableTriggerEngine: true, disableJobRunner: true,
            disableOutboxWorker: true, disableLockSampler: true, disableOrchestrator: true,
        });
        await app.ready();
    });
    afterAll(async () => {
        await app.close();
    });

    beforeEach(async () => {
        await resetTestData();
        clearReferenceBooks();
        const { pair, btcAsset, usdAsset } = await createTestAssetAndPair(pool);
        pairId = pair.id;
        allowSymbolForTest(pair.symbol);
        for (const name of ["alice", "bob"]) {
            const u = await createTestUser(pool, { email: `${name}@test.local` });
            await createTestWallets(pool, u.id, btcAsset.id, usdAsset.id, "0.00000000", "100000.00000000");
            if (name === "alice") alice = u.id; else bob = u.id;
        }
        const m = await createMatch(alice, bob, 1, [pairId]);
        await acceptMatch(m.id, bob);
        matchId = m.id;

        seedReferenceBook(pairId, "83000", "83010");
        await mkt(alice, "BUY", "0.20000000");           // alice long
        await landAt(BASE + c.at(0));
        await mkt(bob, "SELL", "0.15000000");            // bob short
        await landAt(BASE + c.at(1));
        seedReferenceBook(pairId, "84000", "84010");
        await lim(alice, "SELL", "0.05000000", "84005"); // alice rests an ask inside the touch...
        await mkt(bob, "BUY", "0.05000000");             // ...bob lifts it: alice is the maker
        await landAt(BASE + c.at(2));
        await mkt(alice, "SELL", "0.30000000");          // alice flips short
        await landAt(BASE + c.at(3));
        seedReferenceBook(pairId, "85000", "85020");
        await completeMatch(matchId);                    // both still open: closed at the match end
        await landAt(END - 1000);                        // (a second before it's stamped, so the end point is its own)
        await pool.query(`UPDATE matches SET started_at = $2, completed_at = $3 WHERE id = $1`,
            [matchId, new Date(BASE), new Date(END)]);

        await seedCandles("1m", MIN);
        await seedCandles("5m", 5 * MIN);
        await seedCandles("1h", HOUR);
    });

    async function fillsOf(uid: string) {
        const { rows } = await pool.query<{ ts: Date; fee: string }>(
            `SELECT t.executed_at AS ts, t.fee_amount::text AS fee
               FROM trades t JOIN orders o ON o.id = t.buy_order_id OR o.id = t.sell_order_id
              WHERE o.match_id = $1 AND o.user_id = $2 ORDER BY t.executed_at`,
            [matchId, uid]);
        return rows.map((r) => r.ts.getTime());
    }

    it(`picks ${c.timeframe} candles: about one per ${c.timeframe} of the match`, async () => {
        const res = await replay();
        expect(res.statusCode, res.body).toBe(200);
        const body = res.json();
        expect(body.candleTimeframe).toBe(c.timeframe);
        const candles = Object.values(body.candles)[0] as { ts: number }[];
        expect(candles).toHaveLength(c.candles);
        expect(candles[0]!.ts).toBe(BASE);
    });

    it.runIf(c.timeframe === "1m")("1m candles aged out (kept 30 days): falls back to 5m, and the curve is unchanged at the end", async () => {
        await pool.query(`DELETE FROM candles WHERE pair_id = $1 AND timeframe = '1m'`, [pairId]);
        const body = (await replay()).json();
        expect(body.candleTimeframe).toBe("5m");
        expect(Object.values(body.candles)[0]).toHaveLength(3);
        expect(body.curves[alice].at(-1).ts).toBe(END);
    });

    it("both curves run from the match start to the match end on one clock", async () => {
        const body = (await replay()).json();
        const chal = body.curves[alice] as { ts: number }[];
        const opp = body.curves[bob] as { ts: number }[];
        expect(chal.map((p) => p.ts)).toEqual(opp.map((p) => p.ts));
        expect(chal[0]!.ts).toBe(BASE);
        expect(chal.at(-1)!.ts).toBe(END);
        const ts = chal.map((p) => p.ts);
        expect([...ts].sort((a, b) => a - b)).toEqual(ts);
        expect(new Set(ts).size).toBe(ts.length);
    });

    it("has a point at every fill, with that fill's fee already taken", async () => {
        const body = (await replay()).json();
        for (const uid of [alice, bob]) {
            const curve = body.curves[uid] as { ts: number; realizedPnl: number; pnlPct: number }[];
            const times = new Set(curve.map((p) => p.ts));
            for (const ts of await fillsOf(uid)) expect(times.has(ts), `no point at fill ${new Date(ts).toISOString()}`).toBe(true);
            // Opening fill: nothing realized yet, so the point is exactly minus the fee.
            const first = curve.find((p) => p.ts === BASE + c.at(uid === alice ? 0 : 1))!;
            expect(first.realizedPnl).toBeLessThan(0);
            expect(first.pnlPct).toBeLessThan(0);
        }
    });

    it("ORACLE: each curve ends on the stored headline P&L, fees included", async () => {
        const body = (await replay()).json();
        const { rows: [m] } = await pool.query<{ challenger_pnl_pct: string; opponent_pnl_pct: string }>(
            `SELECT challenger_pnl_pct::text, opponent_pnl_pct::text FROM matches WHERE id = $1`, [matchId]);
        const { rows: fees } = await pool.query<{ user_id: string; fees: string }>(
            `SELECT user_id, fees_paid_quote::text AS fees FROM positions WHERE match_id = $1`, [matchId]);
        for (const f of fees) expect(Number(f.fees)).toBeGreaterThan(0);
        for (const [uid, stored] of [[alice, m!.challenger_pnl_pct], [bob, m!.opponent_pnl_pct]] as const) {
            expect(Number(stored)).not.toBe(0);
            const last = body.curves[uid].at(-1);
            expect(last.ts).toBe(END);
            expect(last.unrealizedPnl).toBe(0);
            expect(last.pnlPct).toBeCloseTo(Number(stored), 6);
            // The fills reach it on their own: the point at the last fill (the
            // match-end close) is computed, not the recorded result.
            const fillTimes = await fillsOf(uid);
            const atLastFill = body.curves[uid].find((p: { ts: number }) => p.ts === fillTimes.at(-1));
            expect(fillTimes.at(-1)).toBeLessThan(END);
            expect(atLastFill.unrealizedPnl).toBe(0);
            expect(atLastFill.pnlPct).toBeCloseTo(Number(stored), 6);
        }
    });
});
