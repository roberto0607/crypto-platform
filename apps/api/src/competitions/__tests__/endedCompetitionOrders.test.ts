/**
 * An ended CUSTOM or WEEKLY competition takes no more orders: past end_at (or
 * once ENDED / CANCELLED) an order on its wallets is refused with
 * competition_ended, through the order pipeline and over HTTP. A running
 * competition still trades.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

vi.mock("../../notifications/notificationService", () => ({
    notifyTriggerFired: vi.fn().mockResolvedValue(undefined),
}));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { pool } from "../../db/pool";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { allowSymbolForTest } from "../../market/marketSymbols";
import { placeOrderWithSnapshot } from "../../trading/phase6OrderService";

let pairId: string;
let btcAssetId: string;
let usdAssetId: string;
let userId: string;

async function competition(type: "CUSTOM" | "WEEKLY", status: string, endAt: string): Promise<string> {
    const { rows: [c] } = await pool.query<{ id: string }>(
        `INSERT INTO competitions (name, start_at, end_at, status, competition_type)
         VALUES ('c', now() - interval '2 days', ${endAt}, $1, $2) RETURNING id`,
        [status, type],
    );
    for (const [asset, bal] of [[usdAssetId, "5000"], [btcAssetId, "1"]] as const) {
        await pool.query(
            `INSERT INTO wallets (user_id, asset_id, balance, reserved, competition_id) VALUES ($1, $2, $3, 0, $4)`,
            [userId, asset, bal, c!.id],
        );
    }
    return c!.id;
}

const buy = (competitionId: string) => placeOrderWithSnapshot(
    userId, { pairId, side: "BUY", type: "MARKET", qty: "0.00100000" },
    undefined, undefined, competitionId, null,
);

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    await resetTestData();
    clearReferenceBooks();
    const { pair, btcAsset, usdAsset } = await createTestAssetAndPair(pool);
    pairId = pair.id;
    btcAssetId = btcAsset.id;
    usdAssetId = usdAsset.id;
    allowSymbolForTest(pair.symbol);
    seedReferenceBook(pairId, "83000", "83010");
    userId = (await createTestUser(pool)).id;
});

describe("orders in an ended competition", () => {
    it.each([
        ["CUSTOM", "ACTIVE", "now() - interval '1 minute'"],   // past end_at, lifecycle job not run yet
        ["WEEKLY", "ACTIVE", "now() - interval '1 minute'"],
        ["CUSTOM", "ENDED", "now() - interval '1 hour'"],
        ["WEEKLY", "CANCELLED", "now() + interval '1 day'"],   // canceled early
    ] as const)("%s %s (end %s) is refused", async (type, status, endAt) => {
        const id = await competition(type, status, endAt);
        await expect(buy(id)).rejects.toMatchObject({ code: "competition_ended" });
        const { rows } = await pool.query(`SELECT 1 FROM orders WHERE competition_id = $1`, [id]);
        expect(rows).toHaveLength(0);
    });

    it("a running competition still trades", async () => {
        const id = await competition("CUSTOM", "ACTIVE", "now() + interval '1 day'");
        const res = await buy(id);
        expect(res.order.status).toBe("FILLED");
    });

    describe("over HTTP", () => {
        let app: FastifyInstance;
        beforeAll(async () => {
            app = await buildApp({
                logger: false, disableKrakenFeed: true, disableTriggerEngine: true, disableJobRunner: true,
                disableOutboxWorker: true, disableLockSampler: true, disableOrchestrator: true, disableRateLimit: true,
            });
            await app.ready();
        });
        afterAll(async () => {
            await app.close();
        });

        it("answers 409 competition_ended (the web shows its message)", async () => {
            await pool.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [userId]);
            const id = await competition("WEEKLY", "ACTIVE", "now() - interval '1 minute'");
            const res = await app.inject({
                method: "POST", url: "/orders",
                headers: {
                    authorization: `Bearer ${app.jwt.sign({ sub: userId, role: "USER" }, { expiresIn: 3600 })}`,
                    "x-competition-id": id,
                },
                payload: { scope: "free", pairId, side: "BUY", type: "MARKET", qty: "0.00100000" },
            });
            expect(res.statusCode).toBe(409);
            expect(res.json()).toMatchObject({ ok: false, error: "competition_ended" });
        });
    });
});
