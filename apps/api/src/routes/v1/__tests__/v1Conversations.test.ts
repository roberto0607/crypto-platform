import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../app";
import { pool } from "../../../db/pool";
import { ensureMigrations, resetTestData } from "../../../testing/resetDb";
import { createTestUser } from "../../../testing/fixtures";
import { subscribe, unsubscribe, type EventHandler } from "../../../events/eventBus";
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

const BURST_TIMEOUT = 30_000;

function auth(app: FastifyInstance, sub: string) {
    return { authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` };
}

/** Capture events of a given type delivered to a specific user. */
function captureFor(userId: string, type: AppEvent["type"]): { events: unknown[]; stop: () => void } {
    const events: unknown[] = [];
    const handler: EventHandler = (e: AppEvent) => {
        if (e.type === type) events.push(e.data);
    };
    subscribe(userId, handler);
    return { events, stop: () => unsubscribe(handler) };
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

describe("Friends DM (Phase 2, text-only)", () => {
    let app: FastifyInstance;
    let alice: { id: string };
    let bob: { id: string };
    let carol: { id: string };

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
        carol = await createTestUser(pool, { email: "carol@test.com" });
    });

    describe("POST /v1/conversations/dm", () => {
        it("creates a conversation between accepted friends", async () => {
            await befriend(app, alice.id, bob.id);
            const res = await app.inject({
                method: "POST",
                url: "/v1/conversations/dm",
                headers: auth(app, alice.id),
                payload: { friendId: bob.id },
            });
            expect(res.statusCode).toBe(201);
            expect(res.json().conversation.type).toBe("dm");
        });

        it("get-or-create returns the SAME conversation on repeat calls, from either side", async () => {
            await befriend(app, alice.id, bob.id);
            const first = await app.inject({
                method: "POST",
                url: "/v1/conversations/dm",
                headers: auth(app, alice.id),
                payload: { friendId: bob.id },
            });
            const second = await app.inject({
                method: "POST",
                url: "/v1/conversations/dm",
                headers: auth(app, bob.id),
                payload: { friendId: alice.id },
            });
            expect(second.json().conversation.id).toBe(first.json().conversation.id);
        });

        it("403s with friendship_required when there's no friendship", async () => {
            const res = await app.inject({
                method: "POST",
                url: "/v1/conversations/dm",
                headers: auth(app, alice.id),
                payload: { friendId: bob.id },
            });
            expect(res.statusCode).toBe(403);
            expect(res.json().code).toBe("friendship_required");
        });

        it("403s with friendship_required while a request is still pending", async () => {
            await app.inject({
                method: "POST",
                url: "/v1/friends/request",
                headers: auth(app, alice.id),
                payload: { friendId: bob.id },
            });
            const res = await app.inject({
                method: "POST",
                url: "/v1/conversations/dm",
                headers: auth(app, alice.id),
                payload: { friendId: bob.id },
            });
            expect(res.statusCode).toBe(403);
            expect(res.json().code).toBe("friendship_required");
        });

        it("400s a DM request to yourself", async () => {
            const res = await app.inject({
                method: "POST",
                url: "/v1/conversations/dm",
                headers: auth(app, alice.id),
                payload: { friendId: alice.id },
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().code).toBe("cannot_friend_self");
        });
    });

    describe("GET /v1/conversations", () => {
        it("lists my DM conversations with the other participant's info", async () => {
            await befriend(app, alice.id, bob.id);
            await app.inject({
                method: "POST",
                url: "/v1/conversations/dm",
                headers: auth(app, alice.id),
                payload: { friendId: bob.id },
            });

            const res = await app.inject({
                method: "GET",
                url: "/v1/conversations",
                headers: auth(app, alice.id),
            });
            expect(res.statusCode).toBe(200);
            const { conversations } = res.json();
            expect(conversations).toHaveLength(1);
            expect(conversations[0].other_user_id).toBe(bob.id);
        });
    });

    describe("messages", () => {
        async function dmBetween(a: { id: string }, b: { id: string }): Promise<string> {
            await befriend(app, a.id, b.id);
            const res = await app.inject({
                method: "POST",
                url: "/v1/conversations/dm",
                headers: auth(app, a.id),
                payload: { friendId: b.id },
            });
            return res.json().conversation.id;
        }

        it("sends and lists a text message", async () => {
            const conversationId = await dmBetween(alice, bob);

            const send = await app.inject({
                method: "POST",
                url: `/v1/conversations/${conversationId}/messages`,
                headers: auth(app, alice.id),
                payload: { body: "hey bob" },
            });
            expect(send.statusCode).toBe(201);
            expect(send.json().message.body).toBe("hey bob");
            expect(send.json().message.image_url).toBeNull();

            const list = await app.inject({
                method: "GET",
                url: `/v1/conversations/${conversationId}/messages`,
                headers: auth(app, bob.id),
            });
            expect(list.statusCode).toBe(200);
            expect(list.json().data).toHaveLength(1);
            expect(list.json().data[0].body).toBe("hey bob");
        });

        it("paginates message history with a cursor", async () => {
            const conversationId = await dmBetween(alice, bob);
            for (let i = 0; i < 5; i++) {
                await app.inject({
                    method: "POST",
                    url: `/v1/conversations/${conversationId}/messages`,
                    headers: auth(app, alice.id),
                    payload: { body: `msg ${i}` },
                });
            }

            const page1 = await app.inject({
                method: "GET",
                url: `/v1/conversations/${conversationId}/messages?limit=2`,
                headers: auth(app, alice.id),
            });
            expect(page1.json().data).toHaveLength(2);
            expect(page1.json().nextCursor).not.toBeNull();

            const page2 = await app.inject({
                method: "GET",
                url: `/v1/conversations/${conversationId}/messages?limit=2&cursor=${encodeURIComponent(page1.json().nextCursor)}`,
                headers: auth(app, alice.id),
            });
            expect(page2.json().data).toHaveLength(2);

            const ids1 = page1.json().data.map((m: { id: string }) => m.id);
            const ids2 = page2.json().data.map((m: { id: string }) => m.id);
            expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
        });

        it("forbids a non-participant from sending or listing", async () => {
            const conversationId = await dmBetween(alice, bob);

            const send = await app.inject({
                method: "POST",
                url: `/v1/conversations/${conversationId}/messages`,
                headers: auth(app, carol.id),
                payload: { body: "hi" },
            });
            expect(send.statusCode).toBe(403);

            const list = await app.inject({
                method: "GET",
                url: `/v1/conversations/${conversationId}/messages`,
                headers: auth(app, carol.id),
            });
            expect(list.statusCode).toBe(403);
        });

        it("404s a nonexistent conversation", async () => {
            const res = await app.inject({
                method: "POST",
                url: "/v1/conversations/00000000-0000-0000-0000-000000000000/messages",
                headers: auth(app, alice.id),
                payload: { body: "hi" },
            });
            expect(res.statusCode).toBe(404);
            expect(res.json().code).toBe("conversation_not_found");
        });

        it("rejects a whitespace-only body as message_empty", async () => {
            const conversationId = await dmBetween(alice, bob);
            const res = await app.inject({
                method: "POST",
                url: `/v1/conversations/${conversationId}/messages`,
                headers: auth(app, alice.id),
                payload: { body: "   " },
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().code).toBe("message_empty");
        });

        it("rejects a message containing a blocked word", async () => {
            const conversationId = await dmBetween(alice, bob);
            const res = await app.inject({
                method: "POST",
                url: `/v1/conversations/${conversationId}/messages`,
                headers: auth(app, alice.id),
                payload: { body: "you're a fucking idiot" },
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().code).toBe("message_contains_profanity");
        });

        it("publishes message.received to the OTHER participant only", async () => {
            const conversationId = await dmBetween(alice, bob);
            const recipient = captureFor(bob.id, "message.received");
            const sender = captureFor(alice.id, "message.received");
            const outsider = captureFor(carol.id, "message.received");
            try {
                await app.inject({
                    method: "POST",
                    url: `/v1/conversations/${conversationId}/messages`,
                    headers: auth(app, alice.id),
                    payload: { body: "hey bob" },
                });

                expect(recipient.events).toHaveLength(1);
                const data = recipient.events[0] as MessageReceivedData;
                expect(data.conversationId).toBe(conversationId);
                expect(data.conversationType).toBe("dm");
                expect(data.senderId).toBe(alice.id);
                expect(data.body).toBe("hey bob");
                expect(sender.events).toHaveLength(0);
                expect(outsider.events).toHaveLength(0);
            } finally {
                recipient.stop();
                sender.stop();
                outsider.stop();
            }
        });

        it(
            "rate-limits message sends past 20/min",
            async () => {
                const conversationId = await dmBetween(alice, bob);
                for (let i = 0; i < 20; i++) {
                    const res = await app.inject({
                        method: "POST",
                        url: `/v1/conversations/${conversationId}/messages`,
                        headers: auth(app, alice.id),
                        payload: { body: `msg ${i}` },
                    });
                    expect(res.statusCode).toBe(201);
                }
                const overflow = await app.inject({
                    method: "POST",
                    url: `/v1/conversations/${conversationId}/messages`,
                    headers: auth(app, alice.id),
                    payload: { body: "one too many" },
                });
                expect(overflow.statusCode).toBe(429);
            },
            BURST_TIMEOUT,
        );
    });

    it("requires auth on every route", async () => {
        const nilId = "00000000-0000-0000-0000-000000000000";
        const routes: Array<[string, string, Record<string, unknown> | undefined]> = [
            ["POST", "/v1/conversations/dm", { friendId: nilId }],
            ["GET", "/v1/conversations", undefined],
            ["GET", `/v1/conversations/${nilId}/messages`, undefined],
            ["POST", `/v1/conversations/${nilId}/messages`, { body: "hi" }],
        ];
        for (const [method, url, payload] of routes) {
            const res = await app.inject({ method: method as "GET" | "POST", url, payload });
            expect(res.statusCode).toBe(401);
        }
    });
});
