# Runbook: cancel orphaned TP/SL/trailing triggers

Before the position-close fix, closing a position never canceled the triggers protecting it. A
manual CLOSE POSITION, or one OCO leg firing next to a standalone trailing stop, left the remaining
triggers **ACTIVE** and invisible in the UI. If price later reached one, it fired a market order
against no position and opened a new, unprotected one. QA on 2026-10-11 reproduced this in prod
(a closed short left a BUY TP at 81,500 and a BUY SL at 85,000 armed).

The fix stops new orphans:
- closing a position cancels its triggers (`triggers/positionCloseTriggers.ts`)
- every trigger is reduce-only at fire time (`triggerEngine.fireTrigger`)

`pnpm triggers:cancel-orphans` cleans up the ones already in prod. It's one-time and reversible
from its snapshot. Logic and safety notes are in `apps/api/src/triggers/cancelOrphans.ts`.

## What it treats as an orphan

An **ACTIVE** trigger whose side would reduce a position the user doesn't hold in **any** scope
(free-play, competition or match):

| Trigger side | Orphan when the user has… |
|---|---|
| SELL (protects a long) | no position with `base_qty > 0` on that pair |
| BUY (protects a short) | no position with `base_qty < 0` on that pair |

Never touched:
- Triggers whose position still exists.
- TRIGGERED / CANCELED / FAILED rows.

Nothing is ever deleted. A canceled row gets `status = 'CANCELED'` and
`fail_reason = 'orphan_cleanup'`.

**Caveat:** a trigger created directly through the API as an *entry* order (for example, a
buy-stop meant to open a long while flat) looks the same as an orphan. The UI never creates those.
Since the fix, every trigger is reduce-only, so such a trigger can no longer open a position
anyway. It would cancel itself with `no_position` when it fired. The dry run lists every
candidate, so you can see each one before committing.

## Order

1. **Merge and deploy the fix PR first.** Otherwise new orphans keep appearing behind the cleanup.
2. **Dry-run.** Run it from your laptop, in `apps/api` of a checkout with your `.env`. The script
   needs `JWT_ACCESS_SECRET` set to *something* to load config.

   Confirm the live Postgres service name first. The shell may be linked to
   `Postgres-OLD-crashed`, which must stay untouched. The commands below assume `Postgres-v2`.

   ```bash
   cd apps/api
   railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm triggers:cancel-orphans'
   ```

   Check the output:
   - `orphaned ACTIVE triggers: N`, plus counts by pair and the number of users.
   - One row per trigger: pair, user email, kind, side, trigger price, qty, `vs last` (how far the
     trigger is from the pair's last price, which shows how close it is to firing), an OCO flag and
     created time.
   - Spot-check one or two against a user's position history if anything looks surprising.
   - To narrow the run: `--user <uuid>`.
3. **Commit.**

   ```bash
   railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm triggers:cancel-orphans --commit'
   ```

   It cancels them in **one transaction**. The orphan condition is re-checked inside the same
   `UPDATE`, so a trigger whose user opened a matching position since the dry run is left ACTIVE
   (the output says how many). It writes `orphan-triggers-<timestamp>.json` (gitignored) with every
   canceled row in full, then prints the undo command. Keep the file.
4. **Verify:** a dry run again shows `orphaned ACTIVE triggers: 0`.

## Undo

```bash
railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm triggers:cancel-orphans --revert orphan-triggers-<timestamp>.json'
```

This re-activates exactly the snapshot's ids, and only rows still marked
`CANCELED / orphan_cleanup`. A trigger a user touched since then is skipped and counted. A
re-activated trigger with no position is still harmless: being reduce-only, it cancels itself
(`no_position`) instead of trading when it fires.
