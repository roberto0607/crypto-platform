import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser";
import { v1HandleError } from "../../http/v1Error";
import { AppError } from "../../errors/AppError";
import { parseChartLayoutConfig, layoutNameSchema } from "../../chartLayouts/configSchema";
import {
    listChartLayouts,
    createChartLayout,
    updateChartLayout,
    deleteChartLayout,
} from "../../chartLayouts/chartLayoutRepo";

/**
 * Saved chart layouts (indicators, panes, VPVR mode, timeframe) per user.
 * Every query is scoped to req.user, so another user's id reads as 404.
 *
 * The Fastify body schemas are documentation only (`type: object`, nothing
 * typed): Zod is the single validator, so Ajv never coerces or strips a
 * field before Zod sees it, and unknown keys reach Zod's .strict() → 400.
 */

const createBody = z
    .object({ name: layoutNameSchema, config: z.unknown(), isDefault: z.boolean().optional() })
    .strict();

const patchBody = z
    .object({ name: layoutNameSchema.optional(), config: z.unknown().optional(), isDefault: z.boolean().optional() })
    .strict()
    .refine((b) => b.name !== undefined || b.config !== undefined || b.isDefault !== undefined, {
        message: "nothing to update",
    });

const idParams = z.object({ id: z.string().uuid() });

function parseConfigOrThrow(raw: unknown) {
    const res = parseChartLayoutConfig(raw);
    if (!res.ok) throw new AppError("invalid_input", res.details);
    return res.config;
}

const docBody = {
    type: "object",
    description:
        "name: 1–40 chars (trimmed). config: { version: 1, indicators?, params?, panes?, timeframe? } — " +
        "see src/chartLayouts/catalog.ts for the allowed ids/values. isDefault: boolean.",
    additionalProperties: true,
} as const;

const v1ChartLayouts: FastifyPluginAsync = async (app) => {
    app.get("/chart-layouts", {
        schema: {
            tags: ["Chart layouts"],
            summary: "List my saved chart layouts",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            return reply.send({ layouts: await listChartLayouts(req.user!.id) });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    app.post("/chart-layouts", {
        schema: {
            tags: ["Chart layouts"],
            summary: "Save a chart layout",
            description: "Max 20 per user; names unique per user; isDefault moves the default here.",
            security: [{ bearerAuth: [] }],
            body: docBody,
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const parsed = createBody.safeParse(req.body);
            if (!parsed.success) throw new AppError("invalid_input", parsed.error.flatten());
            const config = parseConfigOrThrow(parsed.data.config);
            const layout = await createChartLayout(req.user!.id, {
                name: parsed.data.name,
                config,
                isDefault: parsed.data.isDefault ?? false,
            });
            return reply.code(201).send({ layout });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    app.patch("/chart-layouts/:id", {
        schema: {
            tags: ["Chart layouts"],
            summary: "Rename, overwrite, or set/clear default on a chart layout",
            security: [{ bearerAuth: [] }],
            body: docBody,
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const p = idParams.safeParse(req.params);
            if (!p.success) throw new AppError("invalid_input", p.error.flatten());
            const parsed = patchBody.safeParse(req.body ?? {});
            if (!parsed.success) throw new AppError("invalid_input", parsed.error.flatten());
            const config = parsed.data.config === undefined ? undefined : parseConfigOrThrow(parsed.data.config);
            const layout = await updateChartLayout(req.user!.id, p.data.id, {
                name: parsed.data.name,
                config,
                isDefault: parsed.data.isDefault,
            });
            return reply.send({ layout });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    app.delete("/chart-layouts/:id", {
        schema: {
            tags: ["Chart layouts"],
            summary: "Delete a chart layout",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const p = idParams.safeParse(req.params);
            if (!p.success) throw new AppError("invalid_input", p.error.flatten());
            await deleteChartLayout(req.user!.id, p.data.id);
            return reply.code(204).send();
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1ChartLayouts;
