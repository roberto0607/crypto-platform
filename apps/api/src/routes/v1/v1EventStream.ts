import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser";
import { requireRole } from "../../auth/requireRole";
import { v1HandleError } from "../../http/v1Error";
import { AppError } from "../../errors/AppError";
import { listEvents, getEventById } from "../../eventStream/eventRepo";
import { verifyFullChain } from "../../eventStream/eventService";

// ── Zod schemas ──

const listQuery = z.object({
  fromId: z.coerce.number().int().min(1).optional(),
  entityType: z.string().optional(),
  entityId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const eventIdParams = z.object({
  id: z.coerce.number().int().min(1),
});

// ── Routes ──

const v1EventStream: FastifyPluginAsync = async (app) => {
  // GET /v1/admin/event-stream
  app.get(
    "/admin/event-stream",
    { preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const query = listQuery.parse(req.query);
        const { rows, total } = await listEvents({
          fromId: query.fromId?.toString(),
          entityType: query.entityType,
          entityId: query.entityId,
          limit: query.limit,
        });

        reply.send({ data: rows, total });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // GET /v1/admin/event-stream/:id
  app.get(
    "/admin/event-stream/:id",
    { preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const { id } = eventIdParams.parse(req.params);
        const event = await getEventById(id.toString());
        if (!event) {
          throw new AppError("event_not_found");
        }
        reply.send({ data: event });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // POST /v1/admin/event-stream/verify
  app.post(
    "/admin/event-stream/verify",
    { preHandler: [requireUser, requireRole("ADMIN")] },
    async (_req, reply) => {
      try {
        const startMs = performance.now();
        const result = await verifyFullChain();
        const durationMs = Math.round(performance.now() - startMs);

        reply.send({
          data: {
            valid: result.valid,
            firstInvalidId: result.firstInvalidId ?? null,
            totalEvents: result.totalEvents,
            durationMs,
          },
        });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );
};

export default v1EventStream;
