import type { FastifyPluginAsync } from "fastify";
import { requireUser } from "../../auth/requireUser";
import { requireRole } from "../../auth/requireRole";
import { runRetention, getRetentionStats, DEFAULT_CONFIG } from "../../retention/retentionService";
import * as jobRepo from "../../jobs/jobRepo";
import { pool } from "../../db/pool";

const v1Retention: FastifyPluginAsync = async (app) => {
    app.get(
        "/admin/retention-status",
        { schema: { tags: ["Admin"], summary: "Retention status", description: "Returns retention policy config and last run info. Requires ADMIN role.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { config: { type: "object", additionalProperties: true }, last_run: { type: "object", nullable: true, additionalProperties: true } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
        async (_req, reply) => {
            const jobRow = await jobRepo.getJobRow("retention");
            reply.send({
                config: DEFAULT_CONFIG,
                last_run: jobRow ?? null,
            });
        },
    );

    app.post(
        "/admin/retention/run",
        { schema: { tags: ["Admin"], summary: "Run retention", description: "Manually triggers data retention cleanup. Requires ADMIN role.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { result: { type: "object", additionalProperties: true } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
        async (req, reply) => {
            const result = await runRetention(pool, req.log as any);
            reply.send({ result });
        },
    );

    app.get(
        "/admin/retention/stats",
        { schema: { tags: ["Admin"], summary: "Retention stats", description: "Returns row counts and table sizes for retention-managed tables. Requires ADMIN role.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { stats: { type: "object", additionalProperties: true } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
        async (_req, reply) => {
            const stats = await getRetentionStats(pool);
            reply.send({ stats });
        },
    );
};

export default v1Retention;
