# Runbook: convert open SPOT positions to 1x ISOLATED (`pnpm leverage:convert`)

Leverage Phase 1, step 2 (`docs/designs/2026-10-13-leverage-design.md` §6). One-way: there is no reverse script.

## What it does

Every open SPOT position of a real user, in free-play or a competition, becomes a 1x ISOLATED position at its own entry price. Equity is unchanged at any mark. Not touched:

- match positions and match wallets (a match keeps the model stamped at accept);
- bots and `@system.local` users;
- positions already ISOLATED, and flat rows.

Per position of size `q` at entry `P` (`M = |q|·P`):

| Step | Long | Short |
|---|---|---|
| Resting SPOT orders of that user on that pair and scope | canceled (`cancel_reason = 'leverage_conversion'`, `ORDER_CANCELLED` outbox) | same |
| Base wallet (`POSITION_CONVERSION`) | −q | +\|q\| |
| USD: base settled at P (`POSITION_CONVERSION`) | +M | −M |
| USD: margin (`MARGIN_LOCK`) | −M | −M |
| Net USD | 0 | −2M |
| Position | ISOLATED, 1x, margin M, liq price, epoch + 1 | same |

Only the position's qty leaves the base wallet. If the wallet holds a different amount (old drift), the difference stays in it and is reported as **residue**.

A user is **blocked** (left as is, reported) when:

- `insufficient_usd`: a short's 2M doesn't fit the USD that's free after the cancels;
- `short_past_liq`: the mark is already at or past a short's 1x liq price (≈ 2× entry);
- `no_mark`: a short's pair has no `last_price` to check that against;
- `wallet_missing`.

Each user is one transaction, under trading's lock order (pairs → wallets → positions), so it's safe while the site and the liquidation engine are live. Before each commit, the scope's equity is recomputed from the database. Any difference rolls that user back (`equity_mismatch`).

## Steps

From `apps/api`, with `DATABASE_URL` (and `REDIS_URL`, so open trade pages get the wallet/order updates) pointing at the target:

1. **Dry run** (the default; writes nothing):
   ```
   pnpm leverage:convert
   pnpm leverage:convert --user <uuid>      # one user
   ```
   For each user it prints:
   - the positions (qty, entry, margin, liq, mark, base wallet before → after, residue);
   - the orders it would cancel;
   - the ledger entries;
   - USD and reserved, before → after;
   - equity before → after (must match);
   - a summary of would-convert / blocked / failed / system users skipped.
2. Review the blocked users and any residue.
3. **Apply**:
   ```
   pnpm leverage:convert --apply
   ```
   This writes `leverage-convert-<timestamp>.json` with every user's outcome and plan. The exit code is 1 if any user failed. Failed users are rolled back and the others are unaffected.
4. **Re-run** `--apply` whenever you like: it converts only what is still SPOT (for example, positions opened SPOT before `LEVERAGE_ENABLED` was turned on, or users unblocked by a deposit). Re-running changes nothing for users already converted.

## Checks after

```sql
-- nothing SPOT left outside matches, except system users and blocked users
SELECT p.user_id, u.email, tp.symbol, p.base_qty FROM positions p
JOIN users u ON u.id = p.user_id JOIN trading_pairs tp ON tp.id = p.pair_id
WHERE p.match_id IS NULL AND p.margin_mode = 'SPOT' AND p.base_qty <> 0;

-- what the run did
SELECT target_id, created_at, metadata FROM audit_log WHERE action = 'leverage.convert' ORDER BY created_at DESC;
```
