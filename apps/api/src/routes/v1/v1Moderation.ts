import type { FastifyPluginAsync } from "fastify";
import { requireUser } from "../../auth/requireUser.js";
import { v1HandleError } from "../../http/v1Error.js";
import { reportMessage } from "../../chat/chatService.js";

const v1Moderation: FastifyPluginAsync = async (app) => {
    // POST /v1/messages/:id/report — report a message. No UI/admin view yet;
    // this just gets a durable, non-ephemeral record into flagged_messages
    // (see 076_flagged_messages.sql for why it snapshots rather than just FKs).
    app.post("/messages/:id/report", {
        schema: {
            tags: ["Chat"],
            summary: "Report a message",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "string", format: "uuid" } },
            },
            body: {
                type: "object",
                properties: { reason: { type: "string", maxLength: 500 } },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const userId = req.user!.id;
            const { id } = req.params as { id: string };
            const { reason } = (req.body as { reason?: string } | undefined) ?? {};
            const flagged = await reportMessage(userId, id, reason);
            return reply.code(201).send({ ok: true, flagged });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Moderation;
