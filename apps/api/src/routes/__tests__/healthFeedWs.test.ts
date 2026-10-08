import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// /health is Railway's healthcheckPath: a stale feed must still be a 200, and
// the krakenWs fields added for the feed watchdogs must survive Fastify's
// response-schema serialization (fields missing from the schema are dropped).
const staleHealth = {
    connected: true,
    lastTickAt: 1_700_000_000_000,
    secondsSinceLastTick: 2,
    status: "stale",
    heartbeatAgeMs: 812,
    bookKillEnabled: false,
    symbols: {
        "BTC/USD": { bookAgeMs: 40, status: "ok" },
        "ETH/USD": { bookAgeMs: null, status: "waiting" },
        "SOL/USD": { bookAgeMs: 9_400, status: "stale" },
    },
};

const staleCoinbase = {
    connected: true,
    status: "stale",
    lastTradeAt: 1_700_000_000_000,
    secondsSinceLastTrade: 0,
    heartbeatAgeMs: 430,
    heartbeatKillEnabled: true,
    symbolKillEnabled: false,
    batches: 1,
    symbols: {
        "BTC/USD": { tradeAgeMs: 120, status: "ok" },
        "ETH/USD": { tradeAgeMs: 71_000, status: "quiet" },
        "SOL/USD": { tradeAgeMs: 64_000, status: "stale" },
        "XRP/USD": { tradeAgeMs: null, status: "waiting" },
    },
};

vi.mock("../../feeds/coinbaseWs", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../feeds/coinbaseWs")>()),
    getCoinbaseWsHealth: () => staleCoinbase,
}));

vi.mock("../../market/krakenWs", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../market/krakenWs")>()),
    getKrakenWsHealth: () => staleHealth,
}));

import { buildApp } from "../../app";

describe("/health krakenWs + coinbaseWs", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
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

    it("stays 200 with stale feeds and returns per-symbol health for both exchanges unstripped", async () => {
        const res = await app.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual(expect.objectContaining({ ok: true, krakenWs: staleHealth, coinbaseWs: staleCoinbase }));
    });
});
