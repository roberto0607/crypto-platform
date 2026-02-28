import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../../auth/requireUser";
import { requireRole } from "../../auth/requireRole";
import * as jobRepo from "../../jobs/jobRepo";
import { triggerJob } from "../../jobs/jobRunner";

const PatchJobBody = z.object({
    is_enabled: z.boolean().optional(),
    interval_seconds: z.number().int().min(10).max(86400).optional(),
});

const v1Jobs: FastifyPluginAsync = async (app) => {
    app.get(
        "/admin/jobs",
        { preHandler: [requireUser, requireRole("ADMIN")] },
        async (_req, reply) => {
            const rows = await jobRepo.getAllJobRows();
            reply.send({ jobs: rows });
        }
    );

    app.patch(
        "/admin/jobs/:name",
        { preHandler: [requireUser, requireRole("ADMIN")] },
        async (req, reply) => {
            const { name } = req.params as { name: string };
            const body = PatchJobBody.parse(req.body);

            const row = await jobRepo.updateJobConfig(name, body);
            if (!row) {
                return reply.status(404).send({ error: "Job not found" });
            }
            reply.send({ job: row });
        }
    );

    app.post(
        "/admin/jobs/:name/run",
        { preHandler: [requireUser, requireRole("ADMIN")] },
        async (req, reply) => {
            const { name } = req.params as { name: string };
            const result = await triggerJob(name);
            if (result.status === "NOT_FOUND") {
                return reply.status(404).send({ error: result.error });
            }
            reply.send(result);
        }
    );
};

export default v1Jobs;
