/**
 * journalQuery.test.ts: a bad query string on GET /v1/trades/journal (and
 * /summary) is the client's mistake, answered 400 invalid_input, never a
 * 500. The paged list's limit stays capped at 100 (the export has its own
 * path, journalLeverage.test.ts).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { pool } from "../../db/pool";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser } from "../../testing/fixtures";

let app: FastifyInstance;
let userId: string;
const auth = () => ({ authorization: `Bearer ${app.jwt.sign({ sub: userId, role: "USER" }, { expiresIn: 3600 })}` });
const get = (url: string) => app.inject({ method: "GET", url, headers: auth() });

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
    userId = (await createTestUser(pool)).id;
});

describe("GET /v1/trades/journal query validation", () => {
    it.each([
        ["limit above 100", "/v1/trades/journal?limit=500"],
        ["limit 0", "/v1/trades/journal?limit=0"],
        ["limit not a number", "/v1/trades/journal?limit=abc"],
        ["bad direction", "/v1/trades/journal?direction=UP"],
        ["pairId not a uuid", "/v1/trades/journal?pairId=nope"],
        ["summary pairId not a uuid", "/v1/trades/journal/summary?pairId=nope"],
    ])("%s → 400 invalid_input", async (_label, url) => {
        const res = await get(url);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ ok: false, error: "invalid_input" });
    });

    it("a valid limit still pages", async () => {
        const res = await get("/v1/trades/journal?limit=100");
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ ok: true, trades: [] });
    });
});
