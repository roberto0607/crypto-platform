/**
 * apiKeyRouteInventory.test.ts: every route, and what an API key needs on it.
 *
 * The inventory comes from buildApp's onRoute hook (auth/apiKeyScope.ts). It is
 * compared to __fixtures__/apiKeyRouteInventory.json, so a new route (or a
 * changed requirement) fails here until someone looks at it and regenerates
 * the file with WRITE_GOLDEN=1. The trade set is also pinned by hand below:
 * it is the list a reviewer should actually read.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";

const GOLDEN = join(__dirname, "__fixtures__", "apiKeyRouteInventory.json");

/** Every route an API key with the `trade` scope can use to change trading state. */
const TRADE_ROUTES = [
    "POST /orders",
    "DELETE /orders/:id",
    "POST /wallets",
    "POST /replay/start",
    "POST /replay/pause",
    "POST /replay/resume",
    "POST /replay/seek",
    "POST /replay/stop",
    "POST /v1/triggers",
    "DELETE /v1/triggers/:id",
    "PATCH /v1/triggers/:id",
    "POST /v1/oco",
].sort();

/** Writes that only change what the caller reads (the SSE stream's pair list). */
const READ_WRITES = ["POST /v1/events/subscribe"];

let app: FastifyInstance;

beforeAll(async () => {
    app = await buildApp({
        logger: false, disableKrakenFeed: true, disableTriggerEngine: true, disableJobRunner: true,
        disableOutboxWorker: true, disableLockSampler: true, disableOrchestrator: true,
    });
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

const rows = () =>
    [...app.apiKeyRoutes]
        .map((r) => ({ route: `${r.method} ${r.url}`, access: r.apiKeyAuth ? r.access : "no API-key auth" }))
        .sort((a, b) => a.route.localeCompare(b.route));

describe("API-key route inventory", () => {
    it("matches the reviewed inventory", () => {
        const actual = rows();
        if (process.env.WRITE_GOLDEN === "1") writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + "\n");
        expect(actual).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
    });

    it("trade is required exactly on the trading writes", () => {
        const trade = app.apiKeyRoutes.filter((r) => r.apiKeyAuth && r.access === "trade").map((r) => `${r.method} ${r.url}`).sort();
        expect(trade).toEqual(TRADE_ROUTES);
    });

    it("no write is reachable with only the read scope (except the stream's pair list)", () => {
        const writesAsRead = app.apiKeyRoutes
            .filter((r) => r.apiKeyAuth && r.method !== "GET" && r.access === "read")
            .map((r) => `${r.method} ${r.url}`);
        expect(writesAsRead).toEqual(READ_WRITES);
    });

    it("every authenticated route has a requirement (none is left open)", () => {
        expect(app.apiKeyRoutes.filter((r) => r.apiKeyAuth && r.access === null)).toEqual([]);
    });
});
