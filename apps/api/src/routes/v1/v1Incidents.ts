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
    { preHandler: [requireUser, requireRole("ADMIN")] },
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
    { preHandler: [requireUser, requireRole("ADMIN")] },
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
    { preHandler: [requireUser, requireRole("ADMIN")] },
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
    { preHandler: [requireUser, requireRole("ADMIN")] },
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
    { preHandler: [requireUser, requireRole("ADMIN")] },
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
    { preHandler: [requireUser, requireRole("ADMIN")] },
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
    { preHandler: [requireUser, requireRole("ADMIN")] },
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
