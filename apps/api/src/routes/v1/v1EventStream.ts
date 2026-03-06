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
    { schema: { tags: ["Events"], summary: "List event stream", description: "Returns paginated append-only event log. Filter by entity type or entity ID. Requires ADMIN role.", security: [{ bearerAuth: [] }], querystring: { type: "object", properties: { fromId: { type: "integer", minimum: 1 }, entityType: { type: "string" }, entityId: { type: "string", format: "uuid" }, limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } } }, response: { 200: { type: "object", properties: { data: { type: "array", items: { type: "object", additionalProperties: true } }, total: { type: "integer" } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
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
    { schema: { tags: ["Events"], summary: "Get event by ID", description: "Returns a single event from the append-only event log. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "integer" } } }, response: { 200: { type: "object", properties: { data: { type: "object", additionalProperties: true } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
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
    { schema: { tags: ["Events"], summary: "Verify event chain", description: "Verifies the full hash chain integrity of the event log. Requires ADMIN role.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { data: { type: "object", properties: { valid: { type: "boolean" }, firstInvalidId: { type: "integer", nullable: true }, totalEvents: { type: "integer" }, durationMs: { type: "integer" } } } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
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
