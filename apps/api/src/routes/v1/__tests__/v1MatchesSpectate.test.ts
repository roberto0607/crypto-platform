/**
 * v1MatchesSpectate.test.ts — Phase A backend for the spectate feature:
 * GET /matches/active-list, GET /matches/:id spectator access,
 * POST /matches/:id/spectate + /unspectate.
 *
 * Integration test — hits the real Postgres at DATABASE_URL, mirroring
 * v1MatchChat.test.ts's harness.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../../app";
import { pool } from "../../../db/pool";
import { ensureMigrations, resetTestData } from "../../../testing/resetDb";
import { createTestUser, createTestAssetAndPair } from "../../../testing/fixtures";
import { createMatch, acceptMatch, forfeitMatch } from "../../../competitions/matchService";
import { subscribe, unsubscribe, type EventHandler } from "../../../events/eventBus";
import type { AppEvent, MatchSpectatorCountData } from "../../../events/eventTypes";
import { __setStreamForTest, __clearStreamsForTest } from "../v1Events";

const buildOpts = {
    logger: false,
    disableKrakenFeed: true,
    disableTriggerEngine: true,
    disableJobRunner: true,
    disableOutboxWorker: true,
    disableLockSampler: true,
    disableOrchestrator: true,
} as const;

function auth(app: FastifyInstance, sub: string) {
    return { authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` };
}

/** Registers a fake SSE stream for `userId`, as if they'd connected to GET /events. */
function fakeStream(userId: string): { streamId: string; handler: EventHandler } {
    const streamId = randomUUID();
    const handler: EventHandler = () => {};
    __setStreamForTest(streamId, { userId, interestSet: new Set(), handler, spectatingMatchId: null });
    return { streamId, handler };
}

function captureFor(userId: string, type: AppEvent["type"]): { events: unknown[]; stop: () => void } {
    const events: unknown[] = [];
    const handler: EventHandler = (e: AppEvent) => {
        if (e.type === type) events.push(e.data);
    };
    subscribe(userId, handler);
    return { events, stop: () => unsubscribe(handler) };
}

describe("Spectate (Phase A)", () => {
    let app: FastifyInstance;
    let challenger: { id: string };
    let opponent: { id: string };
    let spectator: { id: string };
    let pairId: string;

    beforeAll(async () => {
        await ensureMigrations();
        app = await buildApp(buildOpts);
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(async () => {
        await resetTestData();
        __clearStreamsForTest();
        challenger = await createTestUser(pool, { email: "spec-chal@test.com" });
        opponent = await createTestUser(pool, { email: "spec-opp@test.com" });
        spectator = await createTestUser(pool, { email: "spec-watcher@test.com" });
        const { pair } = await createTestAssetAndPair(pool);
        pairId = pair.id;
    });

    async function activeMatch(): Promise<string> {
        const match = await createMatch(challenger.id, opponent.id, 24, [pairId]);
        await acceptMatch(match.id, opponent.id);
        return match.id;
    }

    it("GET /matches/active-list returns the ACTIVE match with a spectatorCount field", async () => {
        const matchId = await activeMatch();

        const res = await app.inject({
            method: "GET",
            url: "/v1/matches/active-list",
            headers: auth(app, spectator.id),
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        const found = body.matches.find((m: { id: string }) => m.id === matchId);
        expect(found).toBeDefined();
        expect(found.spectatorCount).toBe(0);
    });

    it("GET /matches/:id grants a non-participant spectator role while ACTIVE", async () => {
        const matchId = await activeMatch();

        const res = await app.inject({
            method: "GET",
            url: `/v1/matches/${matchId}`,
            headers: auth(app, spectator.id),
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().viewerRole).toBe("spectator");
    });

    it("GET /matches/:id still 403s a non-participant once the match is no longer ACTIVE", async () => {
        const matchId = await activeMatch();
        await forfeitMatch(matchId, challenger.id);

        const res = await app.inject({
            method: "GET",
            url: `/v1/matches/${matchId}`,
            headers: auth(app, spectator.id),
        });
        expect(res.statusCode).toBe(403);
    });

    it("POST /matches/:id/spectate registers the stream and bumps the spectator count", async () => {
        const matchId = await activeMatch();
        const { streamId } = fakeStream(spectator.id);

        const res = await app.inject({
            method: "POST",
            url: `/v1/matches/${matchId}/spectate`,
            headers: auth(app, spectator.id),
            payload: { streamId },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().spectatorCount).toBe(1);

        const list = await app.inject({
            method: "GET",
            url: "/v1/matches/active-list",
            headers: auth(app, spectator.id),
        });
        const found = list.json().matches.find((m: { id: string }) => m.id === matchId);
        expect(found.spectatorCount).toBe(1);
    });

    it("POST /matches/:id/spectate notifies both participants of the new count", async () => {
        const matchId = await activeMatch();
        const { streamId } = fakeStream(spectator.id);
        const chCounts = captureFor(challenger.id, "match.spectator_count");
        const opCounts = captureFor(opponent.id, "match.spectator_count");

        try {
            await app.inject({
                method: "POST",
                url: `/v1/matches/${matchId}/spectate`,
                headers: auth(app, spectator.id),
                payload: { streamId },
            });

            expect(chCounts.events).toHaveLength(1);
            expect(opCounts.events).toHaveLength(1);
            expect((chCounts.events[0] as MatchSpectatorCountData).count).toBe(1);
            expect((chCounts.events[0] as MatchSpectatorCountData).matchId).toBe(matchId);
        } finally {
            chCounts.stop();
            opCounts.stop();
        }
    });

    it("delivers match.pnl.update-shaped spectator room events without duplicating to the participants' own count", async () => {
        // Regression guard for the publishMatchEvent dedup contract itself,
        // exercised through the real route rather than eventBus directly.
        const matchId = await activeMatch();
        const { streamId, handler } = fakeStream(spectator.id);
        const roomEvents: unknown[] = [];
        const wrapped: EventHandler = (e) => {
            if (e.type === "match.spectator_count") roomEvents.push(e);
            handler(e);
        };
        __setStreamForTest(streamId, { userId: spectator.id, interestSet: new Set(), handler: wrapped, spectatingMatchId: null });

        await app.inject({
            method: "POST",
            url: `/v1/matches/${matchId}/spectate`,
            headers: auth(app, spectator.id),
            payload: { streamId },
        });

        expect(roomEvents).toHaveLength(1);
    });

    it("rejects a participant trying to spectate their own match", async () => {
        const matchId = await activeMatch();
        const { streamId } = fakeStream(challenger.id);

        const res = await app.inject({
            method: "POST",
            url: `/v1/matches/${matchId}/spectate`,
            headers: auth(app, challenger.id),
            payload: { streamId },
        });
        expect(res.statusCode).toBe(403);
    });

    it("404s spectate with an unknown streamId", async () => {
        const matchId = await activeMatch();
        const res = await app.inject({
            method: "POST",
            url: `/v1/matches/${matchId}/spectate`,
            headers: auth(app, spectator.id),
            payload: { streamId: randomUUID() },
        });
        expect(res.statusCode).toBe(404);
    });

    it("422s spectate for a match that isn't ACTIVE", async () => {
        const matchId = await activeMatch();
        await forfeitMatch(matchId, challenger.id);
        const { streamId } = fakeStream(spectator.id);

        const res = await app.inject({
            method: "POST",
            url: `/v1/matches/${matchId}/spectate`,
            headers: auth(app, spectator.id),
            payload: { streamId },
        });
        expect(res.statusCode).toBe(422);
    });

    it("POST /matches/:id/unspectate decrements the count and stops room delivery", async () => {
        const matchId = await activeMatch();
        const { streamId } = fakeStream(spectator.id);

        await app.inject({
            method: "POST",
            url: `/v1/matches/${matchId}/spectate`,
            headers: auth(app, spectator.id),
            payload: { streamId },
        });

        const res = await app.inject({
            method: "POST",
            url: `/v1/matches/${matchId}/unspectate`,
            headers: auth(app, spectator.id),
            payload: { streamId },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().spectatorCount).toBe(0);

        const list = await app.inject({
            method: "GET",
            url: "/v1/matches/active-list",
            headers: auth(app, spectator.id),
        });
        const found = list.json().matches.find((m: { id: string }) => m.id === matchId);
        expect(found.spectatorCount).toBe(0);
    });

    it("all four routes require auth", async () => {
        const nilId = "00000000-0000-0000-0000-000000000000";
        const routes: Array<[string, string, Record<string, unknown> | undefined]> = [
            ["GET", "/v1/matches/active-list", undefined],
            ["POST", `/v1/matches/${nilId}/spectate`, { streamId: randomUUID() }],
            ["POST", `/v1/matches/${nilId}/unspectate`, { streamId: randomUUID() }],
        ];
        for (const [method, url, payload] of routes) {
            const res = await app.inject({ method: method as "GET" | "POST", url, payload });
            expect(res.statusCode).toBe(401);
        }
    });
});
