import type { FastifyPluginAsync } from "fastify";
import { requireUser } from "../../auth/requireUser.js";
import { v1HandleError } from "../../http/v1Error.js";
import { decodeCursor, parseLimit, slicePage } from "../../http/pagination.js";
import {
    getOrCreateDmConversation,
    listMyConversations,
    sendMessage,
    listMessages,
} from "../../chat/chatService.js";

const v1Conversations: FastifyPluginAsync = async (app) => {
    // POST /v1/conversations/dm — get-or-create a DM conversation with a friend
    app.post("/conversations/dm", {
        schema: {
            tags: ["Chat"],
            summary: "Get or create a DM conversation with an accepted friend",
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
            const conversation = await getOrCreateDmConversation(userId, friendId);
            return reply.code(201).send({ ok: true, conversation });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/conversations — list my DM conversations
    app.get("/conversations", {
        schema: {
            tags: ["Chat"],
            summary: "List my conversations",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const userId = req.user!.id;
            const conversations = await listMyConversations(userId);
            return reply.send({ ok: true, conversations });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/conversations/:id/messages — paginated history
    app.get("/conversations/:id/messages", {
        schema: {
            tags: ["Chat"],
            summary: "List messages in a conversation (paginated)",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "string", format: "uuid" } },
            },
            querystring: {
                type: "object",
                properties: {
                    limit: { type: "string", description: "Page size (default 50, max 100)" },
                    cursor: { type: "string", description: "Cursor from previous page's nextCursor" },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const userId = req.user!.id;
            const { id } = req.params as { id: string };
            const { limit: rawLimit, cursor: rawCursor } = req.query as { limit?: string; cursor?: string };

            const limit = parseLimit(rawLimit);
            const cursor = decodeCursor<{ ca: string; id: string }>(rawCursor);

            const rows = await listMessages(id, userId, limit, cursor);
            const page = slicePage(rows, limit, (row) => ({ ca: row.created_at, id: row.id }));

            return reply.send({ ok: true, ...page });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // POST /v1/conversations/:id/messages — send a text message
    app.post("/conversations/:id/messages", {
        schema: {
            tags: ["Chat"],
            summary: "Send a message",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "string", format: "uuid" } },
            },
            body: {
                type: "object",
                required: ["body"],
                properties: { body: { type: "string", minLength: 1, maxLength: 2000 } },
            },
        },
        preHandler: requireUser,
        // 20 messages/min per user — keyed the same way as the global default
        // (app.ts's user-JWT/IP keyGenerator), just a tighter ceiling than the
        // general 200/min so chat spam can't ride the general request budget.
        config: { rateLimit: { max: 20, timeWindow: 60_000 } },
    }, async (req, reply) => {
        try {
            const userId = req.user!.id;
            const { id } = req.params as { id: string };
            const { body } = req.body as { body: string };
            const message = await sendMessage(id, userId, body);
            return reply.code(201).send({ ok: true, message });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Conversations;
