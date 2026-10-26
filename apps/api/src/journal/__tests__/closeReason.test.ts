/**
 * closeReason.test.ts: closed_trades.close_reason (leverage PR 6a; the column
 * is from migration 096). Every journal row a closing fill writes records
 * why the position closed: MANUAL (an ordinary order), TP / SL / TRAILING (a
 * trigger's derived order), LIQUIDATION (the liquidation engine's close).
 * The journal API returns it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { pool } from "../../db/pool";
import { config } from "../../config";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { resetMarketDataPairIdCache } from "../../market/marketSymbols";
import { placeOrderWithSnapshot } from "../../trading/phase6OrderService";
import { createTriggerOrder } from "../../triggers/triggerRepo";
import { fireTrigger } from "../../triggers/triggerEngine";
import type { TriggerKind } from "../../triggers/triggerTypes";

let app: FastifyInstance;
let pairId: string;
let btcAssetId: string;
let usdAssetId: string;
const saved = { ...config.leverage };

async function trader(): Promise<string> {
    const u = await createTestUser(pool);
    await createTestWallets(pool, u.id, btcAssetId, usdAssetId, "0.00000000", "10000.00000000");
    return u.id;
}

const market = (uid: string, side: "BUY" | "SELL", qty: string, leverage?: number) =>
    placeOrderWithSnapshot(uid, { pairId, side, type: "MARKET", qty, leverage });

async function reasons(uid: string): Promise<(string | null)[]> {
    const { rows } = await pool.query<{ close_reason: string | null }>(
        `SELECT close_reason FROM closed_trades WHERE user_id = $1 ORDER BY exit_at, id`, [uid]);
    return rows.map((r) => r.close_reason);
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

describe("closed_trades.close_reason", () => {
    it("an ordinary closing order: MANUAL (spot and reduce-only)", async () => {
        const u = await trader();
        await market(u, "BUY", "0.02000000");
        await market(u, "SELL", "0.01000000");
        await placeOrderWithSnapshot(u, { pairId, side: "SELL", type: "MARKET", qty: "0.01000000", reduceOnly: true });
        expect(await reasons(u)).toEqual(["MANUAL", "MANUAL"]);
    });

    it.each([
        ["TAKE_PROFIT_MARKET", "TP", "SELL", "84000", "85000"],
        ["STOP_MARKET", "SL", "SELL", "82000", "81000"],
    ] as const)("%s → %s", async (kind, reason, side, trigger, last) => {
        const u = await trader();
        await market(u, "BUY", "0.01000000");
        const t = await createTriggerOrder({ userId: u, pairId, kind: kind as TriggerKind, side, triggerPrice: trigger, qty: "0.01000000", matchId: null });
        seedReferenceBook(pairId, last, last);
        await fireTrigger(t, { last });
        expect(await reasons(u)).toEqual([reason]);
    });

    it("a trailing stop → TRAILING", async () => {
        const u = await trader();
        await market(u, "BUY", "0.01000000");
        const t = await createTriggerOrder({
            userId: u, pairId, kind: "TRAILING_STOP_MARKET", side: "SELL", triggerPrice: "82000", qty: "0.01000000",
            matchId: null, trailingOffset: "1000",
        });
        seedReferenceBook(pairId, "81500", "81500");
        await fireTrigger(t, { last: "81500" });
        expect(await reasons(u)).toEqual(["TRAILING"]);
    });

    it("a liquidation → LIQUIDATION, and GET /v1/trades/journal returns it", async () => {
        Object.assign(config.leverage, { enabled: true, liquidationMode: "execute", maxFreePlay: 10, allowlist: [] });
        const u = await trader();
        await market(u, "BUY", "0.00602409", 10);
        seedReferenceBook(pairId, "75000", "75000");
        await placeOrderWithSnapshot(u, { pairId, side: "SELL", type: "MARKET", qty: "0.00602409" },
            undefined, undefined, null, null, "liquidation", { epoch: 1, side: "LONG" });
        expect(await reasons(u)).toEqual(["LIQUIDATION"]);

        const token = app.jwt.sign({ sub: u, role: "USER" }, { expiresIn: 3600 });
        const res = await app.inject({ method: "GET", url: "/v1/trades/journal", headers: { authorization: `Bearer ${token}` } });
        expect(res.statusCode).toBe(200);
        expect(res.json().trades.map((t: { close_reason: string }) => t.close_reason)).toEqual(["LIQUIDATION"]);
    });

    it("a flip records the closing part only; the user's own reason", async () => {
        const u = await trader();
        await market(u, "BUY", "0.01000000");
        await market(u, "SELL", "0.03000000"); // closes 0.01 (MANUAL), opens 0.02 short
        expect(await reasons(u)).toEqual(["MANUAL"]);
    });
});
