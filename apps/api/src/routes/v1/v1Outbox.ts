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
    { preHandler: [requireUser, requireRole("ADMIN")] },
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
    { preHandler: [requireUser, requireRole("ADMIN")] },
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
    { preHandler: [requireUser, requireRole("ADMIN")] },
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
    { preHandler: [requireUser, requireRole("ADMIN")] },
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
