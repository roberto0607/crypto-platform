import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../app";
import { pool } from "../../../db/pool";
import { ensureMigrations, resetTestData } from "../../../testing/resetDb";
import { createTestUser } from "../../../testing/fixtures";
import { subscribe, unsubscribe, type EventHandler } from "../../../events/eventBus";
import type {
    AppEvent,
    FriendRequestReceivedData,
    FriendRequestAcceptedData,
} from "../../../events/eventTypes";

/** Capture events of a given type delivered to a specific user. */
function captureFor(userId: string, type: AppEvent["type"]): { events: unknown[]; stop: () => void } {
    const events: unknown[] = [];
    const handler: EventHandler = (e: AppEvent) => {
        if (e.type === type) events.push(e.data);
    };
    subscribe(userId, handler);
    return { events, stop: () => unsubscribe(handler) };
}

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

describe("Friendships (Phase 1)", () => {
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

    it("sends a friend request", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/v1/friends/request",
            headers: auth(app, alice.id),
            payload: { friendId: bob.id },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(body.friendship.user_id).toBe(alice.id);
        expect(body.friendship.friend_id).toBe(bob.id);
        expect(body.friendship.status).toBe("pending");
    });

    it("rejects a self-friend request", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/v1/friends/request",
            headers: auth(app, alice.id),
            payload: { friendId: alice.id },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe("cannot_friend_self");
    });

    it("404s requesting a nonexistent user", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/v1/friends/request",
            headers: auth(app, alice.id),
            payload: { friendId: "00000000-0000-0000-0000-000000000000" },
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe("user_not_found");
    });

    it("409s a duplicate request in either direction", async () => {
        await app.inject({
            method: "POST",
            url: "/v1/friends/request",
            headers: auth(app, alice.id),
            payload: { friendId: bob.id },
        });

        const dup = await app.inject({
            method: "POST",
            url: "/v1/friends/request",
            headers: auth(app, alice.id),
            payload: { friendId: bob.id },
        });
        expect(dup.statusCode).toBe(409);
        expect(dup.json().code).toBe("friendship_already_exists");

        const reverse = await app.inject({
            method: "POST",
            url: "/v1/friends/request",
            headers: auth(app, bob.id),
            payload: { friendId: alice.id },
        });
        expect(reverse.statusCode).toBe(409);
    });

    it("lets the recipient accept a pending request", async () => {
        const req = await app.inject({
            method: "POST",
            url: "/v1/friends/request",
            headers: auth(app, alice.id),
            payload: { friendId: bob.id },
        });
        const friendshipId = req.json().friendship.id;

        const res = await app.inject({
            method: "POST",
            url: `/v1/friends/${friendshipId}/accept`,
            headers: auth(app, bob.id),
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().friendship.status).toBe("accepted");
    });

    it("forbids the requester from accepting their own outgoing request", async () => {
        const req = await app.inject({
            method: "POST",
            url: "/v1/friends/request",
            headers: auth(app, alice.id),
            payload: { friendId: bob.id },
        });
        const friendshipId = req.json().friendship.id;

        const res = await app.inject({
            method: "POST",
            url: `/v1/friends/${friendshipId}/accept`,
            headers: auth(app, alice.id),
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe("forbidden");
    });

    it("forbids an unrelated user from accepting someone else's request", async () => {
        const req = await app.inject({
            method: "POST",
            url: "/v1/friends/request",
            headers: auth(app, alice.id),
            payload: { friendId: bob.id },
        });
        const friendshipId = req.json().friendship.id;

        const res = await app.inject({
            method: "POST",
            url: `/v1/friends/${friendshipId}/accept`,
            headers: auth(app, carol.id),
        });
        expect(res.statusCode).toBe(403);
    });

    it("404s accepting a nonexistent friendship id", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/v1/friends/00000000-0000-0000-0000-000000000000/accept",
            headers: auth(app, alice.id),
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe("friendship_not_found");
    });

    it("400s accepting an already-accepted request", async () => {
        const req = await app.inject({
            method: "POST",
            url: "/v1/friends/request",
            headers: auth(app, alice.id),
            payload: { friendId: bob.id },
        });
        const friendshipId = req.json().friendship.id;
        await app.inject({
            method: "POST",
            url: `/v1/friends/${friendshipId}/accept`,
            headers: auth(app, bob.id),
        });

        const res = await app.inject({
            method: "POST",
            url: `/v1/friends/${friendshipId}/accept`,
            headers: auth(app, bob.id),
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe("friendship_not_pending");
    });

    it("lets the recipient reject a pending request, and a fresh request can follow", async () => {
        const req = await app.inject({
            method: "POST",
            url: "/v1/friends/request",
            headers: auth(app, alice.id),
            payload: { friendId: bob.id },
        });
        const friendshipId = req.json().friendship.id;

        const rej = await app.inject({
            method: "POST",
            url: `/v1/friends/${friendshipId}/reject`,
            headers: auth(app, bob.id),
        });
        expect(rej.statusCode).toBe(200);

        // Row is gone — a fresh request should succeed, not 409.
        const again = await app.inject({
            method: "POST",
            url: "/v1/friends/request",
            headers: auth(app, alice.id),
            payload: { friendId: bob.id },
        });
        expect(again.statusCode).toBe(201);
    });

    it("blocks a user with no prior friendship", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/v1/friends/block",
            headers: auth(app, alice.id),
            payload: { targetId: bob.id },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().friendship.status).toBe("blocked");

        // Blocked — a request from the blocked side should now 409, not 201.
        const attempt = await app.inject({
            method: "POST",
            url: "/v1/friends/request",
            headers: auth(app, bob.id),
            payload: { friendId: alice.id },
        });
        expect(attempt.statusCode).toBe(409);
    });

    it("blocks an existing accepted friendship", async () => {
        const req = await app.inject({
            method: "POST",
            url: "/v1/friends/request",
            headers: auth(app, alice.id),
            payload: { friendId: bob.id },
        });
        const friendshipId = req.json().friendship.id;
        await app.inject({
            method: "POST",
            url: `/v1/friends/${friendshipId}/accept`,
            headers: auth(app, bob.id),
        });

        const res = await app.inject({
            method: "POST",
            url: "/v1/friends/block",
            headers: auth(app, bob.id),
            payload: { targetId: alice.id },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().friendship.id).toBe(friendshipId);
        expect(res.json().friendship.status).toBe("blocked");
    });

    it("lists accepted friends and incoming/outgoing pending requests", async () => {
        // alice -> bob (pending, outgoing for alice / incoming for bob)
        await app.inject({
            method: "POST",
            url: "/v1/friends/request",
            headers: auth(app, alice.id),
            payload: { friendId: bob.id },
        });
        // carol -> alice, accepted
        const req2 = await app.inject({
            method: "POST",
            url: "/v1/friends/request",
            headers: auth(app, carol.id),
            payload: { friendId: alice.id },
        });
        await app.inject({
            method: "POST",
            url: `/v1/friends/${req2.json().friendship.id}/accept`,
            headers: auth(app, alice.id),
        });

        const res = await app.inject({
            method: "GET",
            url: "/v1/friends",
            headers: auth(app, alice.id),
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.friends).toHaveLength(1);
        expect(body.friends[0].other_user_id).toBe(carol.id);
        expect(body.outgoingRequests).toHaveLength(1);
        expect(body.outgoingRequests[0].other_user_id).toBe(bob.id);
        expect(body.incomingRequests).toHaveLength(0);
    });

    it("publishes friend_request.received to the recipient only", async () => {
        const recipient = captureFor(bob.id, "friend_request.received");
        const other = captureFor(carol.id, "friend_request.received");
        try {
            const res = await app.inject({
                method: "POST",
                url: "/v1/friends/request",
                headers: auth(app, alice.id),
                payload: { friendId: bob.id },
            });
            const friendshipId = res.json().friendship.id;

            expect(recipient.events).toHaveLength(1);
            const data = recipient.events[0] as FriendRequestReceivedData;
            expect(data.friendshipId).toBe(friendshipId);
            expect(data.requesterId).toBe(alice.id);
            expect(other.events).toHaveLength(0);
        } finally {
            recipient.stop();
            other.stop();
        }
    });

    it("publishes friend_request.accepted to the original requester only", async () => {
        const req = await app.inject({
            method: "POST",
            url: "/v1/friends/request",
            headers: auth(app, alice.id),
            payload: { friendId: bob.id },
        });
        const friendshipId = req.json().friendship.id;

        const requester = captureFor(alice.id, "friend_request.accepted");
        const accepter = captureFor(bob.id, "friend_request.accepted");
        try {
            await app.inject({
                method: "POST",
                url: `/v1/friends/${friendshipId}/accept`,
                headers: auth(app, bob.id),
            });

            expect(requester.events).toHaveLength(1);
            const data = requester.events[0] as FriendRequestAcceptedData;
            expect(data.friendshipId).toBe(friendshipId);
            expect(data.accepterId).toBe(bob.id);
            // Accepter doesn't get their own accept echoed back — the route
            // response already told their client it succeeded.
            expect(accepter.events).toHaveLength(0);
        } finally {
            requester.stop();
            accepter.stop();
        }
    });

    it("requires auth on every route", async () => {
        const nilId = "00000000-0000-0000-0000-000000000000";
        const routes: Array<[string, string, Record<string, unknown> | undefined]> = [
            ["POST", "/v1/friends/request", { friendId: nilId }],
            ["POST", `/v1/friends/${nilId}/accept`, undefined],
            ["POST", `/v1/friends/${nilId}/reject`, undefined],
            ["POST", "/v1/friends/block", { targetId: nilId }],
            ["GET", "/v1/friends", undefined],
        ];
        for (const [method, url, payload] of routes) {
            const res = await app.inject({ method: method as "GET" | "POST", url, payload });
            expect(res.statusCode).toBe(401);
        }
    });
});
