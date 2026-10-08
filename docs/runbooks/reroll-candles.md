# Runbook: re-roll frozen higher-timeframe candles

Before the rollup lookback fix, `candleRollupJob` only ever re-aggregated each timeframe's
**latest** stored bucket. A 5m/15m/1h/4h/1d/1w bucket that stopped being the latest before its
1m rows settled kept stale values. 1m rows settle over 15 minutes: they are written live at minute
close, then Kraken REST replaces the last 15 minutes every 60s. This hit 5m most often, and 4h/1w
whenever the boot rollup had stored the in-progress bucket.

`pnpm candles:reroll` re-derives every bucket from the stored 1m rows, using exactly the job's
bucketing and aggregation, and replaces the rows that differ. It is one-time, and reversible from
its snapshot. Logic and safety notes are in `apps/api/src/market/rerollCandles.ts`.

What it touches:
- Only **finished** buckets that ended **≥ 15 min ago**. Younger ones are still being re-rolled by
  the job itself.
- Only buckets **fully covered** by 1m rows (one per minute). Anything older than 1m retention
  (30 days) or with a 1m gap is reported as `incomplete` and left alone.
- Only the MARKET_SYMBOLS pairs (BTC/USD, ETH/USD, SOL/USD) by default.
- `changed` rows are replaced. `missing` rows (complete 1m history, no stored row) are inserted.
  Nothing is deleted.

## Order

1. **Merge and deploy the candle PR first** (rollup lookback + live 1m storage). Otherwise new
   buckets keep freezing behind the re-roll.
2. **Dry-run** (from your laptop, in `apps/api` of a checkout with your `.env`; the script needs
   `JWT_ACCESS_SECRET` set to *something* to load config).

   Confirm the live Postgres service name first. The shell may be linked to `Postgres-OLD-crashed`,
   which must stay untouched. The commands below assume `Postgres-v2`.

   ```bash
   cd apps/api
   railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm candles:reroll'
   ```

   Check the output:
   - `symbols:` lists BTC/USD, ETH/USD, SOL/USD. A local `.env` `MARKET_SYMBOLS` would override it;
     `--symbols BTC/USD,ETH/USD` narrows it explicitly.
   - One row per symbol × timeframe: `checked`, `incomplete`, `unchanged`, `changed`, `missing`.
     Expect most `changed` on 5m. Only buckets with 1m data are checked at all (1m reaches back
     ~30 days), so a few 1d/1w buckets at the edge of that window show as `incomplete`.
   - The sample lines show `stored → re-rolled` OHLCV for a few changed buckets per series. Spot-check
     one against an exchange chart if anything looks large.
   - To narrow the run: `--tf 5m,15m` and/or `--symbols BTC/USD`.
3. **Commit.**

   ```bash
   railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm candles:reroll --commit'
   ```

   It writes `candle-reroll-<timestamp>.json` (gitignored) **before** writing anything. The file
   holds every row it will replace (old and new values) and every row it will insert. It then
   applies everything in **one transaction**, so either everything is written or nothing is, and
   prints the undo command. Keep the file.

   The live rollup job may write the same recent buckets concurrently. Both derive from the same
   1m rows, so they write the same values.
4. **Verify:** a dry-run again shows `changed 0` and `missing 0`. Buckets that finished since the
   commit belong to the rollup job.

## Undo

```bash
railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm candles:reroll --revert candle-reroll-<timestamp>.json'
```

This restores each replaced row's old values and deletes each inserted row, in one transaction. A
row that changed after the re-roll (for example, re-written by the rollup job) is **skipped and
counted**, never clobbered.
