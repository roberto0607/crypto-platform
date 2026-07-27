import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../app";
import { pool } from "../../../db/pool";
import { ensureMigrations, resetTestData } from "../../../testing/resetDb";
import { createTestUser, createTestAssetAndPair } from "../../../testing/fixtures";
import { createMatch, acceptMatch } from "../../../competitions/matchService";

// Block enforcement extends to BOTH DM and Match Chat — a locked Gate 1
// design decision. Match Chat is otherwise friendship-independent, but a
// block still overrides it (assertNotBlocked in chatService.ts, checked on
// both send and list, not just send — "can't message OR see").

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

async function befriend(app: FastifyInstance, aId: string, bId: string) {
    const req = await app.inject({
        method: "POST",
        url: "/v1/friends/request",
        headers: auth(app, aId),
        payload: { friendId: bId },
    });
    await app.inject({
        method: "POST",
        url: `/v1/friends/${req.json().friendship.id}/accept`,
        headers: auth(app, bId),
    });
}

describe("Block enforcement (Phase 4)", () => {
    let app: FastifyInstance;
    let alice: { id: string };
    let bob: { id: string };

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
        alice = await createTestUser(pool, { email: "alice@test.com" });
        bob = await createTestUser(pool, { email: "bob@test.com" });
    });

    describe("Friends DM", () => {
        it("blocks send AND list once the blocker blocks, from EITHER side", async () => {
            await befriend(app, alice.id, bob.id);
            const conv = await app.inject({
                method: "POST",
                url: "/v1/conversations/dm",
                headers: auth(app, alice.id),
                payload: { friendId: bob.id },
            });
            const conversationId = conv.json().conversation.id;

            // Established DM, one message before the block.
            await app.inject({
                method: "POST",
                url: `/v1/conversations/${conversationId}/messages`,
                headers: auth(app, alice.id),
                payload: { body: "hi before block" },
            });

            await app.inject({
                method: "POST",
                url: "/v1/friends/block",
                headers: auth(app, alice.id),
                payload: { targetId: bob.id },
            });

            // Blocker (alice) is locked out too, not just the blocked party.
            const aliceSend = await app.inject({
                method: "POST",
                url: `/v1/conversations/${conversationId}/messages`,
                headers: auth(app, alice.id),
                payload: { body: "after block" },
            });
            expect(aliceSend.statusCode).toBe(403);
            expect(aliceSend.json().code).toBe("conversation_blocked");

            const bobSend = await app.inject({
                method: "POST",
                url: `/v1/conversations/${conversationId}/messages`,
                headers: auth(app, bob.id),
                payload: { body: "after block" },
            });
            expect(bobSend.statusCode).toBe(403);
            expect(bobSend.json().code).toBe("conversation_blocked");

            const bobList = await app.inject({
                method: "GET",
                url: `/v1/conversations/${conversationId}/messages`,
                headers: auth(app, bob.id),
            });
            expect(bobList.statusCode).toBe(403);
            expect(bobList.json().code).toBe("conversation_blocked");
        });
    });

    describe("Match Chat", () => {
        it("blocks send AND list even with no prior friendship — block overrides Match Chat's open-by-default rule", async () => {
            const { pair } = await createTestAssetAndPair(pool);
            const match = await createMatch(alice.id, bob.id, 24, [pair.id]);
            await acceptMatch(match.id, bob.id);

            // Works before any block — Match Chat needs no friendship.
            const before = await app.inject({
                method: "POST",
                url: `/v1/matches/${match.id}/chat/messages`,
                headers: auth(app, alice.id),
                payload: { body: "gl hf" },
            });
            expect(before.statusCode).toBe(201);

            // Bob blocks alice — no friendship ever existed between them.
            await app.inject({
                method: "POST",
                url: "/v1/friends/block",
                headers: auth(app, bob.id),
                payload: { targetId: alice.id },
            });

            const send = await app.inject({
                method: "POST",
                url: `/v1/matches/${match.id}/chat/messages`,
                headers: auth(app, alice.id),
                payload: { body: "still there?" },
            });
            expect(send.statusCode).toBe(403);
            expect(send.json().code).toBe("conversation_blocked");

            const list = await app.inject({
                method: "GET",
                url: `/v1/matches/${match.id}/chat/messages`,
                headers: auth(app, bob.id),
            });
            expect(list.statusCode).toBe(403);
            expect(list.json().code).toBe("conversation_blocked");
        });
    });
});
