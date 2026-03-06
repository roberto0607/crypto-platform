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
        { schema: { tags: ["Admin"], summary: "List background jobs", description: "Returns all background job configurations and last-run info. Requires ADMIN role.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { jobs: { type: "array", items: { type: "object", additionalProperties: true } } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
        async (_req, reply) => {
            const rows = await jobRepo.getAllJobRows();
            reply.send({ jobs: rows });
        }
    );

    app.patch(
        "/admin/jobs/:name",
        { schema: { tags: ["Admin"], summary: "Update job config", description: "Updates a background job's enabled state or interval. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["name"], properties: { name: { type: "string" } } }, body: { type: "object", properties: { is_enabled: { type: "boolean" }, interval_seconds: { type: "integer", minimum: 10, maximum: 86400 } } }, response: { 200: { type: "object", properties: { job: { type: "object", additionalProperties: true } } }, 404: { type: "object", properties: { error: { type: "string" } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
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
        { schema: { tags: ["Admin"], summary: "Trigger job manually", description: "Immediately runs a background job. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["name"], properties: { name: { type: "string" } } }, response: { 200: { type: "object", additionalProperties: true }, 404: { type: "object", properties: { error: { type: "string" } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
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
