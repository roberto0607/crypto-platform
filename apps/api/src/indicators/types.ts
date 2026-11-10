/**
 * Server-side Candle/Point shapes: numeric fields, parsed once by the route
 * layer from the raw (string) DB row before any indicator function runs.
 * Defined once in packages/indicators (see ./shared).
 */
export type { Candle, Point } from "./shared/types";
