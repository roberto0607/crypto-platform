/**
 * Synthetic in-sample data for the study tests: trending 4h bars from
 * 2019-05-19 to 2024-01-01, with chosen features set to the 7-day forward
 * return plus independent noise (so each predicts, but they correlate with
 * each other well under 0.6), and the rest NULL.
 */
import type { Candle } from "../../../../indicators/shared";
import type { StudyData, StudyRow } from "../studyData";
import { mulberry32 } from "../stats";

const H4 = 14_400;
export const T_START = Date.parse("2019-05-19T00:00:00Z") / 1000;
export const T_END = Date.parse("2024-01-01T00:00:00Z") / 1000;

export function syntheticData(opts: { planted: string[]; noiseFeatures?: string[]; seed?: number; noise?: number }): StudyData {
  const rng = mulberry32(opts.seed ?? 42);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  const n = (T_END - T_START) / H4;
  const h4: Candle[] = [];
  let p = 10_000;
  for (let i = 0; i < n; i++) {
    const drift = 0.0015 * Math.sign(Math.sin(i / 160));
    const open = p;
    const close = open * Math.exp(drift + 0.003 * gauss());
    h4.push({ time: T_START + i * H4, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 1 });
    p = close;
  }
  const rows: StudyRow[] = [];
  for (let k = 0; k < n; k++) {
    const fwd = k + 42 < n ? Math.log(h4[k + 42]!.close / h4[k + 1]!.open) : 0;
    const values: Record<string, number | null> = {};
    for (const f of opts.planted) values[f] = fwd + (opts.noise ?? 0.15) * gauss();
    for (const f of opts.noiseFeatures ?? []) values[f] = gauss();
    rows.push({ barTime: h4[k]!.time, k, year: new Date(h4[k]!.time * 1000).getUTCFullYear(), atr: h4[k]!.close * 0.004, values });
  }
  return { window: { from: T_START, toExclusive: T_END }, h4, rows };
}
