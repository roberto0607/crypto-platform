/**
 * setup_features writer. Every row carries every feature column: a value,
 * or NULL with a reason in `missing`. Upserts on (symbol, bar_time,
 * feature_version), so re-running a backfill replaces rows in place.
 */
import { pool } from "../../db/pool";
import type { FeatureRow } from "./computeFeatures";
import { FEATURE_COLUMNS } from "./featureColumns";
import { FEATURE_VERSION } from "./featureParams";

export type FeatureOrigin = "backfill" | "live";

export const SETUP_FEATURE_COLUMNS: string[] = FEATURE_COLUMNS.map((c) => c.name);

const BATCH = 500;

/** Why a column this row didn't compute is NULL. */
function notComputedReason(source: (typeof FEATURE_COLUMNS)[number]["source"], origin: FeatureOrigin): string {
  if (source === "live" && origin === "backfill") return "live_only";
  return "source_not_wired";
}

export function rowMissing(row: FeatureRow, origin: FeatureOrigin): Record<string, string> {
  const missing: Record<string, string> = { ...row.missing };
  for (const c of FEATURE_COLUMNS) {
    const v = (row.values as Record<string, unknown>)[c.name];
    if (v === undefined && missing[c.name] === undefined) missing[c.name] = notComputedReason(c.source, origin);
  }
  return missing;
}

export async function upsertFeatureRows(
  symbol: string,
  origin: FeatureOrigin,
  rows: FeatureRow[],
  opts: { recordedLate?: boolean; ifAbsent?: boolean } = {},
): Promise<number> {
  const cols = ["symbol", "bar_time", "feature_version", "origin", "recorded_late", "close", "atr14_4h", ...SETUP_FEATURE_COLUMNS, "missing"];
  const width = cols.length;
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const params: unknown[] = [];
    const tuples = batch.map((r, j) => {
      const values = r.values as Record<string, number | boolean | null | undefined>;
      params.push(
        symbol,
        new Date(r.barTime * 1000),
        FEATURE_VERSION,
        origin,
        opts.recordedLate ?? false,
        r.close,
        r.atr14_4h,
        ...SETUP_FEATURE_COLUMNS.map((c) => values[c] ?? null),
        JSON.stringify(rowMissing(r, origin)),
      );
      return `(${cols.map((_, c) => `$${j * width + c + 1}`).join(", ")})`;
    });
    const update = cols.filter((c) => !["symbol", "bar_time", "feature_version"].includes(c)).map((c) => `${c} = EXCLUDED.${c}`);
    // ifAbsent (the live recorder): a row already recorded is never rewritten.
    const onConflict = opts.ifAbsent ? "DO NOTHING" : `DO UPDATE SET ${update.join(", ")}, recorded_at = now()`;
    const { rowCount } = await pool.query(
      `INSERT INTO setup_features (${cols.join(", ")}) VALUES ${tuples.join(", ")}
       ON CONFLICT (symbol, bar_time, feature_version) ${onConflict}`,
      params,
    );
    written += rowCount ?? 0;
  }
  return written;
}
