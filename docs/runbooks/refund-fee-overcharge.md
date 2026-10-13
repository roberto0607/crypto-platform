# Runbook: refund the pre-PR #201 taker fee overcharge

Before PR #201 the matching engine charged the deprecated `trading_pairs.fee_bps` (30 bps) on every
taker fill instead of `taker_fee_bps` (5 bps). That is 25 bps too much, about $0.125 per $50 fill.
PR #201 fixed the engine. `pnpm fees:refund-overcharge` pays back what was already charged.

It's one-time and reversible from its snapshot. Logic and safety notes are in
`apps/api/src/trading/feeRefund.ts`.

## What it refunds

The fills it looks at are the taker's quote-wallet `TRADE_BUY` / `TRADE_SELL` ledger entries that
carry `metadata.fee` but no `metadata.feeRole`. PR #201 adds `feeRole` to every fee it writes, and
before #201 makers were never charged, so these are exactly the pre-fix taker fees.

Each fill's overcharge:

```
overcharge = fee × (fee_bps − taker_fee_bps) / fee_bps   =   fee − quote_amount × taker_fee_bps / 10000
```

`fee_bps` here is the rate the fill **was actually charged** (`fee / trade.quote_amount`), not the
pair's current `fee_bps` column. The two are the same unless someone edited the column after the
fill. The dry run prints the charged rate per fill (`bps paid→taker`) so you can see it.

The script adds **one `FEE_CORRECTION` credit per wallet**, equal to the sum of that wallet's
overcharges. The entry's metadata holds the cutoff, the fill count and the ledger ids it covers.

Never refunded:
- Entries created at or after `--before`. The flag is required.
- Entries with `feeRole`, i.e. anything written by the fixed engine.
- Competition and match wallets (`competition_id` or `match_id` set). Free-play only.
- The market-maker bot (`BOT_USER_ID`), the risk-agent bot (`RISK_AGENT_BOT_USER_ID`) and any
  `@system.local` user. The bot ids come from the env the script runs with, and they default to the
  same values as the API.
- Any wallet that already has a `FEE_CORRECTION` entry. A unique index (migration 093) also makes a
  second credit on the same wallet impossible.

## Order

1. **Deploy this PR first.** It adds migration 093 (the `FEE_CORRECTION` entry type and the
   once-per-wallet index). The script fails with a check-constraint error until it's applied.
2. **Pick the cutoff:** PR #201's deploy time, in UTC with a zone, for example
   `2026-10-11T18:05:00Z`. Take it from the Railway deploy log for `crypto-platform`. The dry run
   also prints `first post-fix fee entry`, the first fill written by the fixed engine. The cutoff
   should be at or a little before it. If it's after, the script says so. That's still safe, because
   entries with `feeRole` are never refunded, but recheck the time.
3. **Dry-run.** Run it from your laptop, in `apps/api` of a checkout with your `.env`. The script
   needs `JWT_ACCESS_SECRET` set to *something* to load config.

   Confirm the live Postgres service name first. The shell may be linked to
   `Postgres-OLD-crashed`, which must stay untouched. The commands below assume `Postgres-v2`.

   ```bash
   cd apps/api
   railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm fees:refund-overcharge --before 2026-10-11T18:05:00Z'
   ```

   Check the output:
   - The header shows `wallets`, `users`, `fills` and the `total` USD.
   - Per user: one row per fill (time, pair, entry, quote, fee, `bps paid→taker`, overcharge) and
     the wallet's refund.
   - `bps paid→taker` should read `30.00→5` throughout. Anything else means that fill was charged a
     different rate. The refund is still correct for it, but it's worth knowing.
   - To narrow the run: `--user <uuid>`.
   - Nothing is written.
4. **Commit.**

   ```bash
   railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm fees:refund-overcharge --before 2026-10-11T18:05:00Z --commit'
   ```

   All credits go in **one transaction**. The affected wallets are locked and the amounts are
   recomputed inside the transaction, so a wallet refunded by an overlapping run is skipped (the
   output says how many). It writes `fee-refund-<timestamp>.json` (gitignored), with every
   `FEE_CORRECTION` entry id, wallet, user and amount, then prints the undo command. Keep the file.
5. **Verify:** running the same dry run again shows `wallets: 0 ... Nothing to do.` Running
   `--commit` twice is a no-op.

## Undo

```bash
railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm fees:refund-overcharge --revert fee-refund-<timestamp>.json'
```

Undo is one transaction that does three things to each `FEE_CORRECTION` entry in the snapshot:
- deletes the entry
- subtracts its amount from the wallet balance
- subtracts the same amount from `balance_after` on any later entry in that wallet

The ledger ends up exactly as if the refund never happened, and those wallets become refundable
again. Entries that are already gone are skipped and counted, so running the revert twice is safe.

If a user has already spent the refund, reverting can push their available USD below zero. This is
paper money, so nothing breaks, but run the revert soon after the commit if you need one.

## Notes

- Shorts and partial fills need no special handling. Every taker fill is its own trade row with its
  own fee, and the refund is per fill.
- Match and competition wallets are excluded by design (their P&L is already final). If you decide to
  refund them later, that's a separate change to the scope filter in `feeRefund.ts`.
