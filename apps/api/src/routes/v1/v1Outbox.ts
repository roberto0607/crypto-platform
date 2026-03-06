import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser";
import { requireRole } from "../../auth/requireRole";
import { v1HandleError } from "../../http/v1Error";
import { AppError } from "../../errors/AppError";
import { listEvents, countByStatus, resetForRetry } from "../../outbox/outboxRepo";
import { processBatch } from "../../outbox/outboxWorker";

// ── Zod schemas ──

const listQuery = z.object({
  status: z.enum(["PENDING", "PROCESSING", "DONE", "FAILED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const retryParams = z.object({
  id: z.string(),
});

// ── Routes ──

const v1Outbox: FastifyPluginAsync = async (app) => {
  // GET /v1/admin/outbox
  app.get(
    "/admin/outbox",
    { schema: { tags: ["Admin"], summary: "List outbox events", description: "Returns outbox events, optionally filtered by status. Requires ADMIN role.", security: [{ bearerAuth: [] }], querystring: { type: "object", properties: { status: { type: "string", enum: ["PENDING", "PROCESSING", "DONE", "FAILED"] }, limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } } }, response: { 200: { type: "object", properties: { data: { type: "array", items: { type: "object", additionalProperties: true } } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const query = listQuery.parse(req.query);
        const events = await listEvents(query.status, query.limit);
        reply.send({ data: events });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // GET /v1/admin/outbox/stats
  app.get(
    "/admin/outbox/stats",
    { schema: { tags: ["Admin"], summary: "Outbox stats", description: "Returns count of outbox events grouped by status. Requires ADMIN role.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { data: { type: "object", additionalProperties: true } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (_req, reply) => {
      try {
        const stats = await countByStatus();
        reply.send({ data: stats });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // POST /v1/admin/outbox/retry/:id
  app.post(
    "/admin/outbox/retry/:id",
    { schema: { tags: ["Admin"], summary: "Retry outbox event", description: "Resets a FAILED outbox event to PENDING for reprocessing. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const { id } = retryParams.parse(req.params);
        const reset = await resetForRetry(id);
        if (!reset) {
          throw new AppError("outbox_event_not_found");
        }
        reply.send({ ok: true });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // POST /v1/admin/outbox/replay
  app.post(
    "/admin/outbox/replay",
    { schema: { tags: ["Admin"], summary: "Replay outbox batch", description: "Processes a batch of pending outbox events. Requires ADMIN role.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { processed: { type: "integer" } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (_req, reply) => {
      try {
        const processed = await processBatch();
        reply.send({ processed });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );
};

export default v1Outbox;
