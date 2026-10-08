# Runbook: re-roll frozen higher-timeframe candles

Before the rollup lookback fix, `candleRollupJob` only ever re-aggregated each timeframe's
**latest** stored bucket. A 5m/15m/1h/4h/1d/1w bucket that stopped being the latest before its
1m rows settled kept stale values. 1m rows settle over 15 minutes: they are written live at minute
close, then Kraken REST replaces the last 15 minutes every 60s. This hit 5m most often, and 4h/1w
whenever the boot rollup had stored the in-progress bucket.

`pnpm candles:reroll` re-derives every bucket from the stored 1m rows, using exactly the job's
bucketing and aggregation. It is one-time, and reversible from its snapshot. Logic and safety notes
are in `apps/api/src/market/rerollCandles.ts`.

## Safe by default

With no flags, `--commit` rewrites a bucket **only if both** of these hold:
- its stored **open/high/low/close differ** from the 1m re-roll (a frozen bucket), and
- its 1m coverage is **complete** (one 1m row per minute of the bucket).

Everything else is reported in the dry run and **left untouched**:

| Column | Meaning | Written? |
|---|---|---|
| `ohlc fixes` | stored OHLC differs from the re-roll (frozen bucket) | **yes** |
| `vol-only (skipped)` | only volume differs. Typical of exchange-native rows (Coinbase backfill) vs the sum of their 1m rows; not a frozen bucket. | only with `--include-volume` |
| `incomplete (skipped)` | 1m history doesn't cover every minute of the bucket (older than 1m retention, or a 1m gap) | **never** |
| `missing (skipped)` | complete 1m coverage, but no stored row | only with `--include-missing` |
| `unchanged` | already matches | no |

Also never touched:
- Buckets that ended less than 15 min ago. The job is still re-rolling those.
- The current bucket.
- Pairs outside MARKET_SYMBOLS (default BTC/USD, ETH/USD, SOL/USD).

Nothing is ever deleted.

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
   - `mode: OHLC fixes only (safe default)`.
   - There is one row per symbol × timeframe with the columns above. Expect most `ohlc fixes` on
     5m. `vol-only` will likely be the biggest column. It's informational.
   - The sample lines show `stored → re-rolled` OHLCV for a few OHLC fixes per series. Spot-check
     one against an exchange chart if anything looks large.
   - To narrow the run: `--tf 5m,15m` and/or `--symbols BTC/USD`.
3. **Commit.**

   ```bash
   railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm candles:reroll --commit'
   ```

   It writes `candle-reroll-<timestamp>.json` (gitignored) **before** writing anything. The file
   holds every row it will replace (old and new values). It then applies the OHLC fixes in **one
   transaction**, so either everything is written or nothing is, and prints the undo command. Keep
   the file.

   The live rollup job may write the same recent buckets concurrently. Both derive from the same
   1m rows, so they write the same values.
4. **Verify:** a dry-run again shows `ohlc fixes 0` everywhere. The `vol-only`, `incomplete` and
   `missing` counts stay as they were, because they're reported, not fixed.

## Opt-ins (not needed for the frozen-bucket repair)

- `--include-volume`: also rewrite volume-only differences, so every timeframe's volume equals the
  sum of its 1m rows.
- `--include-missing`: also insert buckets that have complete 1m coverage but no stored row.

Both go into the same snapshot and are undone by `--revert`.

## Undo

```bash
railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm candles:reroll --revert candle-reroll-<timestamp>.json'
```

This restores each replaced row's old values and deletes each inserted row, in one transaction. A
row that changed after the re-roll (for example, re-written by the rollup job) is **skipped and
counted**, never clobbered.
