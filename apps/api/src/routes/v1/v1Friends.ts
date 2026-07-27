import type { FastifyPluginAsync } from "fastify";
import { requireUser } from "../../auth/requireUser.js";
import { v1HandleError } from "../../http/v1Error.js";
import {
    sendFriendRequest,
    acceptFriendRequestAsUser,
    rejectFriendRequestAsUser,
    blockUserAsUser,
    listFriends,
} from "../../friends/friendshipService.js";

const v1Friends: FastifyPluginAsync = async (app) => {
    // POST /v1/friends/request — send a friend request
    app.post("/friends/request", {
        schema: {
            tags: ["Friends"],
            summary: "Send a friend request",
            security: [{ bearerAuth: [] }],
            body: {
                type: "object",
                required: ["friendId"],
                properties: { friendId: { type: "string", format: "uuid" } },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const userId = req.user!.id;
            const { friendId } = req.body as { friendId: string };
            const friendship = await sendFriendRequest(userId, friendId);
            return reply.code(201).send({ ok: true, friendship });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // POST /v1/friends/:id/accept
    app.post("/friends/:id/accept", {
        schema: {
            tags: ["Friends"],
            summary: "Accept a friend request",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "string", format: "uuid" } },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const userId = req.user!.id;
            const { id } = req.params as { id: string };
            const friendship = await acceptFriendRequestAsUser(id, userId);
            return reply.send({ ok: true, friendship });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // POST /v1/friends/:id/reject
    app.post("/friends/:id/reject", {
        schema: {
            tags: ["Friends"],
            summary: "Reject a friend request",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "string", format: "uuid" } },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const userId = req.user!.id;
            const { id } = req.params as { id: string };
            await rejectFriendRequestAsUser(id, userId);
            return reply.send({ ok: true });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // POST /v1/friends/block — takes a target USER id (body, like /friends/request),
    // not a friendship id — blocking must work even with no existing friendship row.
    app.post("/friends/block", {
        schema: {
            tags: ["Friends"],
            summary: "Block a user",
            security: [{ bearerAuth: [] }],
            body: {
                type: "object",
                required: ["targetId"],
                properties: { targetId: { type: "string", format: "uuid" } },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const userId = req.user!.id;
            const { targetId } = req.body as { targetId: string };
            const friendship = await blockUserAsUser(userId, targetId);
            return reply.send({ ok: true, friendship });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/friends — accepted friends + pending incoming/outgoing requests
    app.get("/friends", {
        schema: {
            tags: ["Friends"],
            summary: "List friends and pending requests",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const userId = req.user!.id;
            const result = await listFriends(userId);
            return reply.send({ ok: true, ...result });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Friends;
