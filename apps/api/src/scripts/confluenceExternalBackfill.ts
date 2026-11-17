/**
 * confluenceExternalBackfill.ts — fill external_series (Deribit funding,
 * Binance OI archive, Fear & Greed; Gate.io/OKX only for ranges inside their
 * last 180 days) for the confluence scanner, then re-run
 * `pnpm agent:features:backfill --skip-sync` to fill the p_* / s_* columns.
 *
 * Usage (from apps/api, DATABASE_URL at a LOCAL research DB; never production):
 *   pnpm agent:features:external-backfill                     # in-sample: 2019-05-19 → 2024-01-01
 *   pnpm agent:features:external-backfill --to 2026-11-17 --confirm-oos
 * Resolution: EXTERNAL_SERIES_RESOLUTION (default 1h; "full" for research DBs).
 *
 * Writes only external_series.
 */
import "dotenv/config";
import { pool } from "../db/pool";
import { config } from "../config";
import { backfillRange } from "../agents/confluence/featureBackfill";
import { runExternalBackfill } from "../agents/confluence/external/externalBackfill";

async function main(): Promise<void> {
  const { from, toExclusive } = backfillRange(process.argv.slice(2));
  const iso = (t: number) => new Date(t * 1000).toISOString();
  console.log(`[external] backfill for rows ${iso(from)} → ${iso(toExclusive)} (exclusive), resolution ${config.externalSeriesResolution}`);
  const r = await runExternalBackfill({ from, toExclusive, log: console.log });
  console.log(`[external] done: ${JSON.stringify(r.counts)}`);
}

main()
  .catch((err) => {
    console.error("[external] backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
