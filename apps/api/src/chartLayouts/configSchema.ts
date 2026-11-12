import { z } from "zod";
import { CHART_LAYOUT_CATALOG as C, upgradeLegacyEmaConfig, type ChartLayoutConfig } from "./catalog";

/** One z.literal per allowed value (the catalog lists them). */
function oneOf(values: readonly (string | number)[]) {
    const lits = values.map((v) => z.literal(v));
    return lits.length === 1 ? lits[0]! : z.union(lits as unknown as [z.ZodLiteral<string | number>, z.ZodLiteral<string | number>]);
}

/** Strict object with every key optional and the same value schema. */
function optionalRecord<T extends z.ZodTypeAny>(keys: readonly string[], value: T) {
    return z.object(Object.fromEntries(keys.map((k) => [k, value.optional()]))).strict();
}

function paramGroup(spec: Record<string, readonly (string | number)[]>) {
    return z.object(Object.fromEntries(Object.entries(spec).map(([k, vals]) => [k, oneOf(vals)]))).strict();
}

const MA = C.movingAverages;
const maId = z.string().regex(new RegExp(MA.idPattern));

const movingAverageSchema = z
    .object({
        id: maId,
        type: z.enum(MA.types as unknown as [string, ...string[]]),
        length: z.number().int().min(MA.length.min).max(MA.length.max),
        color: z.string().regex(new RegExp(MA.colorPattern)),
        timeframe: z.enum(MA.timeframes as unknown as [string, ...string[]]).optional(),
        forming: z.boolean().optional(),
    })
    .strict();

/** A number in [min, max] on the step grid (step 1 → integer). Every key required. */
function numericGroup(spec: Record<string, { min: number; max: number; step: number }>) {
    return z
        .object(Object.fromEntries(Object.entries(spec).map(([k, r]) => [
            k,
            z.number().min(r.min).max(r.max).refine((v) => Math.abs(v / r.step - Math.round(v / r.step)) < 1e-9, {
                message: `must be a multiple of ${r.step}`,
            }),
        ])))
        .strict();
}

const paramsSchema = z
    .object({
        ...Object.fromEntries(Object.entries(C.params).map(([group, spec]) => [group, paramGroup(spec).optional()])),
        ...Object.fromEntries(Object.entries(C.numericParams).map(([group, spec]) => [group, numericGroup(spec).optional()])),
        movingAverages: z
            .array(movingAverageSchema)
            .max(MA.maxLines)
            .refine((a) => new Set(a.map((m) => m.id)).size === a.length, { message: "duplicate moving average id" })
            .optional(),
        maCross: z.object({ fast: maId, slow: maId }).strict().optional(),
    })
    .strict()
    .superRefine((p, ctx) => {
        if (!p.maCross) return;
        const ids = new Set((p.movingAverages ?? []).map((m) => m.id));
        const { fast, slow } = p.maCross;
        if (fast === slow || !ids.has(fast) || !ids.has(slow)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["maCross"], message: "maCross must name two different moving averages" });
        }
    });

const paneId = z.enum(C.panes as unknown as [string, ...string[]]);

const panesSchema = z
    .object({
        order: z
            .array(paneId)
            .max(C.panes.length)
            .refine((a) => new Set(a).size === a.length, { message: "duplicate pane in order" })
            .optional(),
        collapsed: optionalRecord(C.panes, z.boolean()).optional(),
        heights: optionalRecord(C.panes, z.number().int().min(C.paneHeight.min).max(C.paneHeight.max)).optional(),
    })
    .strict();

const configShape = z
    .object({
        version: z.literal(1),
        indicators: optionalRecord(C.indicators, z.boolean()).optional(),
        params: paramsSchema.optional(),
        panes: panesSchema.optional(),
        timeframe: z.enum(C.timeframes as unknown as [string, ...string[]]).optional(),
    })
    .strict();

export type ParseConfigResult =
    | { ok: true; config: ChartLayoutConfig }
    | { ok: false; details: unknown };

/**
 * Validate a layout config. The size cap runs first, on the raw JSON, so an
 * oversized body is rejected without walking it. Unknown keys anywhere → error,
 * except the old ema20/ema50/ema200 toggles, which become moving-average lines
 * first (a tab still on the pre-list build), so they are never stored.
 */
export function parseChartLayoutConfig(raw: unknown): ParseConfigResult {
    let bytes: number;
    try {
        bytes = Buffer.byteLength(JSON.stringify(raw) ?? "", "utf8");
    } catch {
        return { ok: false, details: { reason: "config_not_serializable" } };
    }
    if (bytes > C.maxConfigBytes) {
        return { ok: false, details: { reason: "config_too_large", maxBytes: C.maxConfigBytes, bytes } };
    }
    const parsed = configShape.safeParse(upgradeLegacyEmaConfig(raw));
    if (!parsed.success) return { ok: false, details: parsed.error.flatten() };
    return { ok: true, config: parsed.data as ChartLayoutConfig };
}

export const layoutNameSchema = z.string().trim().min(1).max(C.nameMaxLength);
