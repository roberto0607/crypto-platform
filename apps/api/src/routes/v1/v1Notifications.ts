import type { FastifyPluginAsync } from "fastify";
import { requireUser } from "../../auth/requireUser.js";
import {
    listNotifications,
    getUnreadCount,
    markAsRead,
    markAllAsRead,
} from "../../notifications/notificationRepo.js";

const v1Notifications: FastifyPluginAsync = async (app) => {
    // GET /v1/notifications — List recent notifications
    app.get("/notifications", {
        schema: {
            tags: ["Notifications"],
            summary: "List notifications",
            security: [{ bearerAuth: [] }],
            querystring: {
                type: "object",
                properties: {
                    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        const userId = req.user!.id;
        const { limit } = req.query as { limit?: number };
        const notifications = await listNotifications(userId, limit ?? 50);
        const unreadCount = await getUnreadCount(userId);
        return reply.send({ ok: true, notifications, unreadCount });
    });

    // POST /v1/notifications/:id/read — Mark a notification as read
    app.post("/notifications/:id/read", {
        schema: {
            tags: ["Notifications"],
            summary: "Mark notification as read",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "string", format: "uuid" } },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        const userId = req.user!.id;
        const { id } = req.params as { id: string };
        await markAsRead(userId, id);
        return reply.send({ ok: true });
    });

    // POST /v1/notifications/read-all — Mark all as read
    app.post("/notifications/read-all", {
        schema: {
            tags: ["Notifications"],
            summary: "Mark all notifications as read",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        const userId = req.user!.id;
        const count = await markAllAsRead(userId);
        return reply.send({ ok: true, markedRead: count });
    });
};

export default v1Notifications;
