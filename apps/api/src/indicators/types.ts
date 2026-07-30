/**
 * Canonical server-side Candle/Point shapes for apps/api/src/indicators/.
 *
 * Ported from apps/web/src/lib/indicators.ts, which defines its own local
 * `Candle` (numeric OHLCV) while apps/web/src/lib/cvd.ts imports a
 * DIFFERENT `Candle` (string OHLCV, from api/endpoints/candles) — those
 * two frontend types don't actually agree with each other. Server-side we
 * use exactly one shape: numeric fields, parsed once by the route layer
 * from the raw (string) DB row before any indicator function runs.
 */

export interface Candle {
  time: number; // epoch seconds (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume?: number;
  sellVolume?: number;
}

export interface Point {
  time: number;
  value: number;
}
