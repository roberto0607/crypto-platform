import type { FastifyPluginAsync } from "fastify";
import { requireUser } from "../../auth/requireUser.js";
import { v1HandleError } from "../../http/v1Error.js";
import { decodeCursor, parseLimit, slicePage } from "../../http/pagination.js";
import { resolveMatchConversationId, sendMessage, listMessages } from "../../chat/chatService.js";

/**
 * Match Chat — reuses Phase 2's sendMessage/listMessages entirely. The only
 * new logic here is resolving matchId -> its chat conversation id; the
 * participant check, rate limit, and profanity filter are the exact same
 * code path Friends DM uses. No friendship gate — Match Chat is open by
 * default between the two match participants, per the locked design.
 */
const v1MatchChat: FastifyPluginAsync = async (app) => {
    // GET /v1/matches/:id/chat/messages — paginated history
    app.get("/matches/:id/chat/messages", {
        schema: {
            tags: ["Chat"],
            summary: "List messages in a match's chat (paginated)",
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
            const { id: matchId } = req.params as { id: string };
            const { limit: rawLimit, cursor: rawCursor } = req.query as { limit?: string; cursor?: string };

            const conversationId = await resolveMatchConversationId(matchId);
            const limit = parseLimit(rawLimit);
            const cursor = decodeCursor<{ ca: string; id: string }>(rawCursor);

            const rows = await listMessages(conversationId, userId, limit, cursor);
            const page = slicePage(rows, limit, (row) => ({ ca: row.created_at, id: row.id }));

            return reply.send({ ok: true, ...page });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // POST /v1/matches/:id/chat/messages — send a text message
    app.post("/matches/:id/chat/messages", {
        schema: {
            tags: ["Chat"],
            summary: "Send a message in a match's chat",
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
        config: { rateLimit: { max: 20, timeWindow: 60_000 } },
    }, async (req, reply) => {
        try {
            const userId = req.user!.id;
            const { id: matchId } = req.params as { id: string };
            const { body } = req.body as { body: string };

            const conversationId = await resolveMatchConversationId(matchId);
            const message = await sendMessage(conversationId, userId, body);

            return reply.code(201).send({ ok: true, message });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1MatchChat;
