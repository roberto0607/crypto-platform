import { z } from "zod";
import { setChartConfigArgsSchema } from "./setChartConfig";
import { commitDrawingArgsSchema } from "./commitDrawing";

/**
 * Args schema for the Chart Analysis Agent's proposeChartConfig tool
 * (Gate 1c). Per the Gate 1c design doc's Q1 decision, calling this tool
 * does NOT mutate a live frontend chart -- it captures the agent's
 * suggested indicator/timeframe/drawing setup, which the runner bundles
 * into the trade proposal's chartConfig field for a future UI to render
 * as an "apply this chart setup" suggestion. Reuses the same indicator
 * vocabulary (setChartConfigArgsSchema) and drawing shape
 * (commitDrawingArgsSchema) Gate 1a defined for the eventual live-mutation
 * tools, so the interface won't need to change when a later gate wires it
 * to a real store mutation -- only the implementation behind the tool
 * name does.
 */
export const proposeChartConfigArgsSchema = z.object({
  timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d", "1w"]).optional(),
  indicators: setChartConfigArgsSchema.optional(),
  drawings: z.array(commitDrawingArgsSchema).max(5).optional(),
});

export type ProposeChartConfigArgs = z.infer<typeof proposeChartConfigArgsSchema>;
