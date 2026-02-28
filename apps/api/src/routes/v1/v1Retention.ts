import type { FastifyPluginAsync } from "fastify";
import { requireUser } from "../../auth/requireUser";
import { requireRole } from "../../auth/requireRole";
import { runRetention, getRetentionStats, DEFAULT_CONFIG } from "../../retention/retentionService";
import * as jobRepo from "../../jobs/jobRepo";
import { pool } from "../../db/pool";

const v1Retention: FastifyPluginAsync = async (app) => {
    app.get(
        "/admin/retention-status",
        { preHandler: [requireUser, requireRole("ADMIN")] },
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
        { preHandler: [requireUser, requireRole("ADMIN")] },
        async (req, reply) => {
            const result = await runRetention(pool, req.log as any);
            reply.send({ result });
        },
    );

    app.get(
        "/admin/retention/stats",
        { preHandler: [requireUser, requireRole("ADMIN")] },
        async (_req, reply) => {
            const stats = await getRetentionStats(pool);
            reply.send({ stats });
        },
    );
};

export default v1Retention;
