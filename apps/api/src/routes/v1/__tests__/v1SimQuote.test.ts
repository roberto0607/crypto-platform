/**
 * GET /v1/sim/quote and the order routes' size errors over HTTP. The pricing
 * itself is covered in trading/__tests__/largeOrders.test.ts; this is the wire.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../app";
import { pool } from "../../../db/pool";
import { resetTestData, ensureMigrations } from "../../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../../testing/fixtures";
import { seedDepthBook, clearReferenceBooks } from "../../../testing/referenceBook";

describe("GET /v1/sim/quote", () => {
    let app: FastifyInstance;
    let headers: Record<string, string>;
    let pairId: string;

    beforeAll(async () => {
        await ensureMigrations();
        app = await buildApp({
            logger: false,
            disableKrakenFeed: true,
            disableTriggerEngine: true,
            disableJobRunner: true,
            disableOutboxWorker: true,
            disableLockSampler: true,
            disableOrchestrator: true,
        });
        await app.ready();
    });
    afterAll(async () => {
        await app.close();
    });
    beforeEach(async () => {
        await resetTestData();
        clearReferenceBooks();
        const u = await createTestUser(pool);
        const assets = await createTestAssetAndPair(pool);
        pairId = assets.pair.id;
        await createTestWallets(pool, u.id, assets.btcAsset.id, assets.usdAsset.id, "0.00000000", "100000.00000000");
        await pool.query(`UPDATE trading_pairs SET last_price = '100000' WHERE id = $1`, [pairId]);
        seedDepthBook(pairId, [[99_990, 100]], [[100_000, 2], [100_010, 3], [100_020, 5]]);
        headers = { authorization: `Bearer ${app.jwt.sign({ sub: u.id, role: "USER" }, { expiresIn: 3600 })}` };
    });

    const get = (query: string) => app.inject({ method: "GET", url: `/v1/sim/quote?pairId=${pairId}&side=BUY&${query}`, headers });

    it("quotes a qty", async () => {
        const res = await get("qty=10");
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({
            executable: true, reason: null, qty: "10.00000000",
            touchPrice: "100000.00000000", estimatedPrice: "100013.00000000", maxOrderNotional: "5000000.00",
        });
    });

    it("solves a budget", async () => {
        const res = await get("budget=50000&leverage=1");
        expect(res.statusCode).toBe(200);
        expect(Number(res.json().qty)).toBeGreaterThan(0.49);
        expect(Number(res.json().qty)).toBeLessThan(0.5);
    });

    it("wants exactly one of qty and budget", async () => {
        expect((await get("qty=1&budget=100")).statusCode).toBe(400);
        expect((await get("leverage=2")).statusCode).toBe(400);
    });

    it("needs a user", async () => {
        const res = await app.inject({ method: "GET", url: `/v1/sim/quote?pairId=${pairId}&side=BUY&qty=1` });
        expect(res.statusCode).toBe(401);
    });
});
