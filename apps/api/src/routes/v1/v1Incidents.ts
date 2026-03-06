import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser";
import { requireRole } from "../../auth/requireRole";
import { auditLog } from "../../audit/log";
import { AppError } from "../../errors/AppError";
import { v1HandleError } from "../../http/v1Error";
import { getIncidentById, listIncidents, listEvents } from "../../incidents/incidentRepo";
import {
  acknowledgeIncident,
  addNote,
  resolveIncident,
} from "../../incidents/incidentService";
import { buildProofPack } from "../../incidents/proofPackService";

// ── Zod schemas ──

const incidentIdParams = z.object({
  id: z.string().uuid(),
});

const listIncidentsQuery = z.object({
  status: z.enum(["OPEN", "INVESTIGATING", "RESOLVED"]).optional(),
  userId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const ackBody = z.object({
  note: z.string().max(2000).optional(),
});

const noteBody = z.object({
  note: z.string().min(1).max(2000),
});

const resolveBody = z.object({
  resolutionSummary: z.record(z.string(), z.unknown()),
});

const proofPackQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  orderId: z.string().uuid().optional(),
});

// ── Routes ──

const v1Incidents: FastifyPluginAsync = async (app) => {
  // GET /v1/admin/incidents
  app.get(
    "/admin/incidents",
    { schema: { tags: ["Admin"], summary: "List incidents", description: "Returns paginated incidents. Filter by status, user, or date range. Requires ADMIN role.", security: [{ bearerAuth: [] }], querystring: { type: "object", properties: { status: { type: "string", enum: ["OPEN", "INVESTIGATING", "RESOLVED"] }, userId: { type: "string", format: "uuid" }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, limit: { type: "integer", minimum: 1, maximum: 100, default: 50 }, offset: { type: "integer", minimum: 0, default: 0 } } }, response: { 200: { type: "object", properties: { data: { type: "array", items: { type: "object", additionalProperties: true } }, total: { type: "integer" } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const query = listIncidentsQuery.parse(req.query);
        const { rows, total } = await listIncidents({
          status: query.status,
          userId: query.userId,
          from: query.from,
          to: query.to,
          limit: query.limit,
          offset: query.offset,
        });

        reply.send({ data: rows, total });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // GET /v1/admin/incidents/:id
  app.get(
    "/admin/incidents/:id",
    { schema: { tags: ["Admin"], summary: "Get incident by ID", description: "Returns a single incident with full details. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", properties: { data: { type: "object", additionalProperties: true } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const { id } = incidentIdParams.parse(req.params);
        const incident = await getIncidentById(id);
        if (!incident) {
          throw new AppError("incident_not_found");
        }
        reply.send({ data: incident });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // GET /v1/admin/incidents/:id/events
  app.get(
    "/admin/incidents/:id/events",
    { schema: { tags: ["Admin"], summary: "List incident events", description: "Returns the timeline of events for an incident. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", properties: { data: { type: "array", items: { type: "object", additionalProperties: true } } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const { id } = incidentIdParams.parse(req.params);
        const incident = await getIncidentById(id);
        if (!incident) {
          throw new AppError("incident_not_found");
        }
        const events = await listEvents(id);
        reply.send({ data: events });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // POST /v1/admin/incidents/:id/ack
  app.post(
    "/admin/incidents/:id/ack",
    { schema: { tags: ["Admin"], summary: "Acknowledge incident", description: "Marks an incident as acknowledged by the admin. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } }, body: { type: "object", properties: { note: { type: "string", maxLength: 2000 } } }, response: { 200: { type: "object", properties: { data: { type: "object", properties: { incidentId: { type: "string" }, acknowledgedAt: { type: "string" } } } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const { id } = incidentIdParams.parse(req.params);
        const body = ackBody.parse(req.body);

        const incident = await getIncidentById(id);
        if (!incident) {
          throw new AppError("incident_not_found");
        }

        await acknowledgeIncident(id, req.user.id, body.note);

        reply.send({
          data: {
            incidentId: id,
            acknowledgedAt: new Date().toISOString(),
          },
        });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // POST /v1/admin/incidents/:id/note
  app.post(
    "/admin/incidents/:id/note",
    { schema: { tags: ["Admin"], summary: "Add incident note", description: "Adds a note to an incident's timeline. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } }, body: { type: "object", required: ["note"], properties: { note: { type: "string", minLength: 1, maxLength: 2000 } } }, response: { 200: { type: "object", properties: { data: { type: "object", properties: { incidentId: { type: "string" } } } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const { id } = incidentIdParams.parse(req.params);
        const body = noteBody.parse(req.body);

        const incident = await getIncidentById(id);
        if (!incident) {
          throw new AppError("incident_not_found");
        }

        await addNote(id, req.user.id, body.note);

        reply.send({
          data: {
            incidentId: id,
          },
        });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // POST /v1/admin/incidents/:id/resolve
  app.post(
    "/admin/incidents/:id/resolve",
    { schema: { tags: ["Admin"], summary: "Resolve incident", description: "Marks an incident as resolved with a resolution summary. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } }, body: { type: "object", required: ["resolutionSummary"], properties: { resolutionSummary: { type: "object", description: "Free-form resolution details" } } }, response: { 200: { type: "object", properties: { data: { type: "object", properties: { incidentId: { type: "string" }, resolvedAt: { type: "string" } } } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const { id } = incidentIdParams.parse(req.params);
        const body = resolveBody.parse(req.body);

        const incident = await getIncidentById(id);
        if (!incident) {
          throw new AppError("incident_not_found");
        }

        await resolveIncident(id, req.user.id, body.resolutionSummary);

        reply.send({
          data: {
            incidentId: id,
            resolvedAt: new Date().toISOString(),
          },
        });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // GET /v1/admin/incidents/:id/proof-pack
  app.get(
    "/admin/incidents/:id/proof-pack",
    { schema: { tags: ["Admin"], summary: "Generate proof pack", description: "Generates a forensic proof pack for an incident including trades, ledger entries, and positions. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } }, querystring: { type: "object", properties: { from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, orderId: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", properties: { data: { type: "object", additionalProperties: true } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const { id } = incidentIdParams.parse(req.params);
        const query = proofPackQuery.parse(req.query);

        const incident = await getIncidentById(id);
        if (!incident) {
          throw new AppError("incident_not_found");
        }

        const proofPack = await buildProofPack({
          userId: incident.user_id,
          incidentId: id,
          orderId: query.orderId,
          fromTs: query.from,
          toTs: query.to,
        });

        auditLog({
          actorUserId: req.user.id,
          action: "PROOF_PACK_GENERATED",
          targetType: "incident",
          targetId: id,
          requestId: req.id,
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          metadata: {
            userId: incident.user_id,
            truncated: proofPack.truncated,
          },
        });

        reply.send({ data: proofPack });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );
};

export default v1Incidents;
