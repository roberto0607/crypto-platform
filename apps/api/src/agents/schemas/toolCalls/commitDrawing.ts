import { z } from "zod";

/**
 * Args schema for a future agent tool that would commit a finished
 * drawing in one call, mirroring apps/web/src/stores/drawingStore.ts's
 * `DRAWING_TOOL_SPECS`. No such one-shot action exists in that store
 * today (only `setActiveTool` + `addPoint` per required point, which
 * simulates the UI gesture) — this schema is written now so Gate 1b's
 * tool wiring and the store's `commitDrawing` action can be designed
 * against the same shape; the store-side action itself is frontend work,
 * out of scope here.
 */
const drawingPointSchema = z.object({
  time: z.number(),
  price: z.number(),
});

export const commitDrawingArgsSchema = z
  .object({
    type: z.enum(["hline", "hray", "vline", "text", "trendline", "rect", "fib"]),
    points: z.array(drawingPointSchema).min(1).max(2),
    text: z.string().optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  })
  .refine(
    (d) => {
      const required = d.type === "trendline" || d.type === "rect" || d.type === "fib" ? 2 : 1;
      return d.points.length === required;
    },
    { message: "points length must match the tool's required point count" },
  );

export type CommitDrawingArgs = z.infer<typeof commitDrawingArgsSchema>;
