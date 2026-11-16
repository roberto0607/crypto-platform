/**
 * confluenceFeatureBackfill.ts — backfill feature_candles (Coinbase BTC-USD
 * 1h/1d) and setup_features rows for the confluence scanner's factor study.
 *
 * Usage (from apps/api, DATABASE_URL at a LOCAL research DB; never production):
 *   pnpm agent:features:backfill                          # in-sample: 2019-05-19 → 2024-01-01
 *   pnpm agent:features:backfill --from 2021-01-01 --to 2022-01-01
 *   pnpm agent:features:backfill --to 2026-11-16 --confirm-oos   # only once the in-sample study is approved
 *   --skip-sync   recompute rows from candles already stored
 *
 * Writes only feature_candles and setup_features.
 */
import "dotenv/config";
import { pool } from "../db/pool";
import { backfillRange, runFeatureBackfill } from "../agents/confluence/featureBackfill";

async function main(): Promise<void> {
  const { from, toExclusive } = backfillRange(process.argv.slice(2));
  const iso = (t: number | null) => (t === null ? "—" : new Date(t * 1000).toISOString());
  console.log(`[features] backfill ${iso(from)} → ${iso(toExclusive)} (exclusive)`);
  const s = await runFeatureBackfill({ from, toExclusive, skipSync: process.argv.includes("--skip-sync"), log: console.log });
  console.log(`[features] wrote ${s.rows} rows, ${iso(s.first)} → ${iso(s.last)}`);
  const nulls = Object.entries(s.nullCounts).sort((a, b) => b[1] - a[1]);
  console.log(`[features] NULLs per column (of ${s.rows}):`);
  for (const [k, n] of nulls) console.log(`  ${k.padEnd(22)} ${n}`);
}

main()
  .catch((err) => {
    console.error("[features] backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
