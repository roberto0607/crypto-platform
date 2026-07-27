import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../app";
import { pool } from "../../../db/pool";
import { ensureMigrations, resetTestData } from "../../../testing/resetDb";
import { createTestUser, createTestAssetAndPair } from "../../../testing/fixtures";
import { createMatch, acceptMatch, forfeitMatch } from "../../../competitions/matchService";

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

describe("Message reports (Phase 4)", () => {
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

    async function dmMessage(): Promise<string> {
        await befriend(app, alice.id, bob.id);
        const conv = await app.inject({
            method: "POST",
            url: "/v1/conversations/dm",
            headers: auth(app, alice.id),
            payload: { friendId: bob.id },
        });
        const send = await app.inject({
            method: "POST",
            url: `/v1/conversations/${conv.json().conversation.id}/messages`,
            headers: auth(app, alice.id),
            payload: { body: "hey bob" },
        });
        return send.json().message.id;
    }

    it("lets a participant report another participant's message", async () => {
        const messageId = await dmMessage();
        const res = await app.inject({
            method: "POST",
            url: `/v1/messages/${messageId}/report`,
            headers: auth(app, bob.id),
            payload: { reason: "spam" },
        });
        expect(res.statusCode).toBe(201);
        const { flagged } = res.json();
        expect(flagged.message_id).toBe(messageId);
        expect(flagged.body_snapshot).toBe("hey bob");
        expect(flagged.sender_id).toBe(alice.id);
        expect(flagged.reporter_id).toBe(bob.id);
        expect(flagged.conversation_type).toBe("dm");
        expect(flagged.reason).toBe("spam");
    });

    it("400s reporting your own message", async () => {
        const messageId = await dmMessage();
        const res = await app.inject({
            method: "POST",
            url: `/v1/messages/${messageId}/report`,
            headers: auth(app, alice.id),
            payload: { reason: "oops" },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe("cannot_report_own_message");
    });

    it("403s a non-participant reporting a message they can't see", async () => {
        const messageId = await dmMessage();
        const res = await app.inject({
            method: "POST",
            url: `/v1/messages/${messageId}/report`,
            headers: auth(app, carol.id),
            payload: { reason: "spam" },
        });
        expect(res.statusCode).toBe(403);
    });

    it("404s reporting a nonexistent message", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/v1/messages/00000000-0000-0000-0000-000000000000/report",
            headers: auth(app, alice.id),
            payload: { reason: "spam" },
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe("message_not_found");
    });

    it("survives the source message being hard-deleted (match chat report outlives the ephemeral purge)", async () => {
        const { pair } = await createTestAssetAndPair(pool);
        const match = await createMatch(alice.id, bob.id, 24, [pair.id]);
        await acceptMatch(match.id, bob.id);

        const send = await app.inject({
            method: "POST",
            url: `/v1/matches/${match.id}/chat/messages`,
            headers: auth(app, alice.id),
            payload: { body: "gg ez" },
        });
        const messageId = send.json().message.id;

        const report = await app.inject({
            method: "POST",
            url: `/v1/messages/${messageId}/report`,
            headers: auth(app, bob.id),
            payload: { reason: "toxic" },
        });
        expect(report.statusCode).toBe(201);
        const flaggedId = report.json().flagged.id;

        // Match ends — Phase 3 hard-deletes the conversation + message.
        await forfeitMatch(match.id, alice.id);
        const { rows: messageRows } = await pool.query(`SELECT id FROM messages WHERE id = $1`, [messageId]);
        expect(messageRows).toHaveLength(0);

        // The report survives with message_id nulled out, snapshot intact.
        const { rows: flaggedRows } = await pool.query(
            `SELECT message_id, body_snapshot, sender_id, conversation_type FROM flagged_messages WHERE id = $1`,
            [flaggedId],
        );
        expect(flaggedRows).toHaveLength(1);
        expect(flaggedRows[0].message_id).toBeNull();
        expect(flaggedRows[0].body_snapshot).toBe("gg ez");
        expect(flaggedRows[0].sender_id).toBe(alice.id);
        expect(flaggedRows[0].conversation_type).toBe("match");
    });

    it("requires auth", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/v1/messages/00000000-0000-0000-0000-000000000000/report",
            payload: { reason: "spam" },
        });
        expect(res.statusCode).toBe(401);
    });
});
