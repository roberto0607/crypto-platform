/**
 * Replay of a real match: no match_positions rows (only the demo seed writes
 * those), so GET /v1/matches/:id/replay rebuilds it from the players' own
 * fills in match scope. Prod: roberto vs berto (Nov 7) both traded and the
 * page said "NO REPLAY AVAILABLE — no recorded trade data".
 *
 * The match is played through the real paths: accept (wallets funded),
 * market and limit orders in match scope (one fill between the two players,
 * so one is the maker), positions left open, completeMatch settles them.
 * ORACLE: each player's last curve point is the stored headline pnl_pct.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";

vi.mock("../../../notifications/notificationService", () => ({
    notifyTriggerFired: vi.fn().mockResolvedValue(undefined),
}));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../app";
import { pool } from "../../../db/pool";
import { config } from "../../../config";
import { ensureMigrations, resetTestData } from "../../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../../testing/referenceBook";
import { allowSymbolForTest } from "../../../market/marketSymbols";
import { placeOrderWithSnapshot } from "../../../trading/phase6OrderService";
import { createMatch, acceptMatch, completeMatch } from "../../matchService";

const FIVE_MIN = 300_000;
const HOUR = 3_600_000;
const saved = { ...config.leverage };

describe.each([
    ["SPOT (leverage off)", false],
    ["ISOLATED (leverage on, 5x)", true],
])("GET /v1/matches/:id/replay, a real match, %s", (_label, leveraged) => {
    let app: FastifyInstance;
    let pairId: string;
    let alice: string;
    let bob: string;
    let matchId: string;

    const auth = (sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` });
    const replay = () => app.inject({ method: "GET", url: `/v1/matches/${matchId}/replay`, headers: auth(alice) });
    const lev = leveraged ? 5 : undefined;
    const mkt = (uid: string, side: "BUY" | "SELL", qty: string) =>
        placeOrderWithSnapshot(uid, { pairId, side, type: "MARKET", qty, leverage: lev }, undefined, undefined, null, matchId);
    const lim = (uid: string, side: "BUY" | "SELL", qty: string, px: string) =>
        placeOrderWithSnapshot(uid, { pairId, side, type: "LIMIT", qty, limitPrice: px, leverage: lev }, undefined, undefined, null, matchId);

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
    afterEach(() => {
        Object.assign(config.leverage, saved, { allowlist: [...saved.allowlist] });
    });

    beforeEach(async () => {
        await resetTestData();
        clearReferenceBooks();
        if (leveraged) Object.assign(config.leverage, { enabled: true, maxFreePlay: 10, maxMatch: 5, allowlist: [] });
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
        await mkt(bob, "SELL", "0.15000000");            // bob short
        seedReferenceBook(pairId, "84000", "84010");
        await lim(alice, "SELL", "0.05000000", "84005"); // alice rests an ask inside the touch...
        await mkt(bob, "BUY", "0.05000000");             // ...bob lifts it: alice is the maker
        await mkt(alice, "SELL", "0.30000000");          // alice flips short
        seedReferenceBook(pairId, "85000", "85020");
        await completeMatch(matchId);                    // both still open: settled at match end

        // 5m candles over the whole match, ±2h.
        const now = Date.now();
        const values: string[] = [];
        const params: unknown[] = [pairId];
        for (let ts = Math.floor((now - 2 * HOUR) / FIVE_MIN) * FIVE_MIN, i = 2; ts <= now + 2 * HOUR; ts += FIVE_MIN, i++) {
            values.push(`($1,'5m',$${i},84000,85500,82500,84500,1)`);
            params.push(new Date(ts));
        }
        await pool.query(
            `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume) VALUES ${values.join(",")}`,
            params,
        );
    });

    it("shows the match's trades instead of 'no replay available'", async () => {
        const res = await replay();
        expect(res.statusCode, res.body).toBe(200);
        const body = res.json();
        expect(body.source).toBe("fills");
        // alice: a long (closed by the maker fill + the flip), then a short
        // closed at match end; bob: a short (reduced by his buy), closed at match end.
        const sides = (uid: string) => body.positions.filter((p: { userId: string }) => p.userId === uid).map((p: { side: string }) => p.side);
        expect(sides(alice)).toEqual(["LONG", "SHORT"]);
        expect(sides(bob)).toEqual(["SHORT"]);
        for (const p of body.positions) {
            expect(p.pairSymbol).toBeTruthy();
            expect(p.closedAt).not.toBeNull();   // match end closed everything
            expect(p.exitPrice).toBeGreaterThan(0);
        }
    });

    it("ORACLE: each player's last point is the stored headline", async () => {
        const body = (await replay()).json();
        const { rows: [m] } = await pool.query<{ challenger_pnl_pct: string; opponent_pnl_pct: string }>(
            `SELECT challenger_pnl_pct::text, opponent_pnl_pct::text FROM matches WHERE id = $1`, [matchId]);
        expect(Number(m!.challenger_pnl_pct)).not.toBe(0);
        for (const [uid, stored] of [[alice, m!.challenger_pnl_pct], [bob, m!.opponent_pnl_pct]] as const) {
            const last = body.curves[uid].at(-1);
            expect(last.unrealizedPnl).toBe(0);
            expect(last.pnlPct).toBeCloseTo(Number(stored), 6);
        }
        // Trips add up to the same thing.
        const tripSum = body.positions.filter((p: { userId: string }) => p.userId === alice)
            .reduce((s: number, p: { pnl: number }) => s + p.pnl, 0);
        expect((tripSum / body.match.startingCapital) * 100).toBeCloseTo(Number(m!.challenger_pnl_pct), 6);
    });

    it("a match nobody traded still has no replay", async () => {
        const m = await createMatch(alice, bob, 1, [pairId]);
        await acceptMatch(m.id, bob);
        await completeMatch(m.id);
        const res = await app.inject({ method: "GET", url: `/v1/matches/${m.id}/replay`, headers: auth(alice) });
        expect(res.statusCode).toBe(422);
        expect(res.json().error).toBe("no_replay_data");
    });
});
