/**
 * Shared read helper for the latest regime_tags row (migration 082),
 * written by apps/api/src/agents/scanner/regimeClassifier.ts. Extracted
 * from the Scanner Agent's runner.ts inline query once a second agent
 * (Chart Analysis) needed the same read.
 */
import { pool } from "../../db/pool";

export interface LatestRegimeTag {
  regime: string | null;
  confidence: string | null;
  created_at: string | null;
}

export async function getLatestRegimeTag(pairId: string): Promise<LatestRegimeTag> {
  const { rows } = await pool.query<{ regime: string; confidence: string | null; created_at: string }>(
    `SELECT regime, confidence, created_at FROM regime_tags WHERE pair_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [pairId],
  );
  return rows[0] ?? { regime: null, confidence: null, created_at: null };
}
