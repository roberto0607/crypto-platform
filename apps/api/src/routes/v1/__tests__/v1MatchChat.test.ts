import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../app";
import { pool } from "../../../db/pool";
import { ensureMigrations, resetTestData } from "../../../testing/resetDb";
import { createTestUser, createTestAssetAndPair } from "../../../testing/fixtures";
import { createMatch, acceptMatch, forfeitMatch, completeMatch, mutualForfeitMatch } from "../../../competitions/matchService";
import { subscribe, unsubscribe, subscribeToMatch, unsubscribeFromMatch, type EventHandler } from "../../../events/eventBus";
import type { AppEvent, MessageReceivedData } from "../../../events/eventTypes";

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

function captureFor(userId: string, type: AppEvent["type"]): { events: unknown[]; stop: () => void } {
    const events: unknown[] = [];
    const handler: EventHandler = (e: AppEvent) => {
        if (e.type === type) events.push(e.data);
    };
    subscribe(userId, handler);
    return { events, stop: () => unsubscribe(handler) };
}

async function conversationForMatch(matchId: string) {
    const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM conversations WHERE type = 'match' AND context_id = $1`,
        [matchId],
    );
    return rows[0] ?? null;
}

describe("Match Chat (Phase 3)", () => {
    let app: FastifyInstance;
    let challenger: { id: string };
    let opponent: { id: string };
    let outsider: { id: string };
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
        challenger = await createTestUser(pool, { email: "chal@test.com" });
        opponent = await createTestUser(pool, { email: "opp@test.com" });
        outsider = await createTestUser(pool, { email: "out@test.com" });
        const { pair } = await createTestAssetAndPair(pool);
        pairId = pair.id;
    });

    async function activeMatch(): Promise<string> {
        const match = await createMatch(challenger.id, opponent.id, 24, [pairId]);
        await acceptMatch(match.id, opponent.id);
        return match.id;
    }

    it("auto-creates a match conversation with both participants when the match starts", async () => {
        const match = await createMatch(challenger.id, opponent.id, 24, [pairId]);

        // Still PENDING — no conversation yet.
        expect(await conversationForMatch(match.id)).toBeNull();

        await acceptMatch(match.id, opponent.id);

        const conversation = await conversationForMatch(match.id);
        expect(conversation).not.toBeNull();

        const { rows: participants } = await pool.query<{ user_id: string }>(
            `SELECT user_id FROM conversation_participants WHERE conversation_id = $1 ORDER BY user_id`,
            [conversation!.id],
        );
        expect(participants.map((p) => p.user_id).sort()).toEqual(
            [challenger.id, opponent.id].sort(),
        );
    });

    it("404s chat routes for a match still PENDING (not yet accepted)", async () => {
        const match = await createMatch(challenger.id, opponent.id, 24, [pairId]);
        const res = await app.inject({
            method: "POST",
            url: `/v1/matches/${match.id}/chat/messages`,
            headers: auth(app, challenger.id),
            payload: { body: "hi" },
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe("conversation_not_found");
    });

    it("lets both participants send and receive messages", async () => {
        const matchId = await activeMatch();

        const send = await app.inject({
            method: "POST",
            url: `/v1/matches/${matchId}/chat/messages`,
            headers: auth(app, challenger.id),
            payload: { body: "gl hf" },
        });
        expect(send.statusCode).toBe(201);

        const list = await app.inject({
            method: "GET",
            url: `/v1/matches/${matchId}/chat/messages`,
            headers: auth(app, opponent.id),
        });
        expect(list.statusCode).toBe(200);
        expect(list.json().data).toHaveLength(1);
        expect(list.json().data[0].body).toBe("gl hf");
    });

    it("publishes message.received (conversationType: match) to the other participant only", async () => {
        const matchId = await activeMatch();
        const recipient = captureFor(opponent.id, "message.received");
        const outsiderCap = captureFor(outsider.id, "message.received");
        try {
            await app.inject({
                method: "POST",
                url: `/v1/matches/${matchId}/chat/messages`,
                headers: auth(app, challenger.id),
                payload: { body: "gg" },
            });
            expect(recipient.events).toHaveLength(1);
            const data = recipient.events[0] as MessageReceivedData;
            expect(data.conversationType).toBe("match");
            expect(data.senderId).toBe(challenger.id);
            expect(outsiderCap.events).toHaveLength(0);
        } finally {
            recipient.stop();
            outsiderCap.stop();
        }
    });

    it("forbids an outsider from sending (spectating is read-only)", async () => {
        const matchId = await activeMatch();

        const send = await app.inject({
            method: "POST",
            url: `/v1/matches/${matchId}/chat/messages`,
            headers: auth(app, outsider.id),
            payload: { body: "let me in" },
        });
        expect(send.statusCode).toBe(403);
    });

    it("lets a non-participant (spectator) read chat while the match is ACTIVE", async () => {
        const matchId = await activeMatch();
        await app.inject({
            method: "POST",
            url: `/v1/matches/${matchId}/chat/messages`,
            headers: auth(app, challenger.id),
            payload: { body: "visible to spectators" },
        });

        const list = await app.inject({
            method: "GET",
            url: `/v1/matches/${matchId}/chat/messages`,
            headers: auth(app, outsider.id),
        });
        expect(list.statusCode).toBe(200);
        expect(list.json().data).toHaveLength(1);
        expect(list.json().data[0].body).toBe("visible to spectators");
    });

    it("also delivers message.received to the match's spectator room (matchId-tagged)", async () => {
        const matchId = await activeMatch();
        const roomEvents: unknown[] = [];
        const handler: EventHandler = (e) => {
            if (e.type === "message.received") roomEvents.push(e.data);
        };
        subscribeToMatch(matchId, handler);
        try {
            await app.inject({
                method: "POST",
                url: `/v1/matches/${matchId}/chat/messages`,
                headers: auth(app, challenger.id),
                payload: { body: "for spectators too" },
            });
            expect(roomEvents).toHaveLength(1);
        } finally {
            unsubscribeFromMatch(handler);
        }
    });

    it("forbids an outsider from reading once the match is no longer ACTIVE", async () => {
        const matchId = await activeMatch();
        await forfeitMatch(matchId, challenger.id);

        // The conversation is purged on end anyway (see the purge test below),
        // so this exercises the same code path a mid-match forfeit-window race
        // would hit: canViewMatch denies a non-participant post-ACTIVE before
        // conversation resolution even matters.
        const list = await app.inject({
            method: "GET",
            url: `/v1/matches/${matchId}/chat/messages`,
            headers: auth(app, outsider.id),
        });
        expect(list.statusCode).toBe(403);
    });

    it("purges the conversation and messages the instant the match ends via forfeit", async () => {
        const matchId = await activeMatch();
        await app.inject({
            method: "POST",
            url: `/v1/matches/${matchId}/chat/messages`,
            headers: auth(app, challenger.id),
            payload: { body: "before forfeit" },
        });
        const conversation = await conversationForMatch(matchId);
        expect(conversation).not.toBeNull();

        await forfeitMatch(matchId, challenger.id);

        expect(await conversationForMatch(matchId)).toBeNull();
        const { rows: orphanMessages } = await pool.query(
            `SELECT id FROM messages WHERE conversation_id = $1`,
            [conversation!.id],
        );
        expect(orphanMessages).toHaveLength(0);

        const res = await app.inject({
            method: "GET",
            url: `/v1/matches/${matchId}/chat/messages`,
            headers: auth(app, challenger.id),
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe("conversation_not_found");
    });

    it("purges the conversation on natural completion (completeMatch)", async () => {
        const matchId = await activeMatch();
        expect(await conversationForMatch(matchId)).not.toBeNull();

        await completeMatch(matchId);

        expect(await conversationForMatch(matchId)).toBeNull();
    });

    it("purges the conversation on mutual forfeit (no-show)", async () => {
        const matchId = await activeMatch();
        expect(await conversationForMatch(matchId)).not.toBeNull();

        await mutualForfeitMatch(matchId);

        expect(await conversationForMatch(matchId)).toBeNull();
    });

    it("requires auth on every route", async () => {
        const nilId = "00000000-0000-0000-0000-000000000000";
        const routes: Array<[string, string, Record<string, unknown> | undefined]> = [
            ["GET", `/v1/matches/${nilId}/chat/messages`, undefined],
            ["POST", `/v1/matches/${nilId}/chat/messages`, { body: "hi" }],
        ];
        for (const [method, url, payload] of routes) {
            const res = await app.inject({ method: method as "GET" | "POST", url, payload });
            expect(res.statusCode).toBe(401);
        }
    });
});
