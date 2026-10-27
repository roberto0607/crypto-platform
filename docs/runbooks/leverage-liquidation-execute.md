# Runbook: switch `LIQUIDATION_MODE` from `log_only` to `execute`

Leverage Phase 2 (`docs/designs/2026-10-13-leverage-design.md` §6). Keep `LEVERAGE_ALLOWLIST` as it is (only your accounts above 1x) for this whole runbook. Clearing the allowlist is a separate step, taken once a real liquidation has been verified end to end.

## What changes

| | `log_only` (now) | `execute` |
|---|---|---|
| Breach confirmed (2 evaluations ≥ 500 ms apart, Kraken book mid) | `liquidations` row `LOG_ONLY`, log `liquidation_would_fire`. Position untouched. | MARKET close at the touch (bid for a long, ask for a short) through the normal order pipeline (`orders.source = 'liquidation'`). |
| Money | Nothing moves. | Margin released, P&L booked with the loss cap, taker fee capped at what's left, the rest back to USD. A gap past bankruptcy books `LIQUIDATION_SHORTFALL`: USD never goes below 0. |
| Records | `LOG_ONLY` row | `EXECUTED` row (fill price, P&L, fee, returned equity, shortfall), journal row with `close_reason = LIQUIDATION` |
| User sees | Nothing | `position.liquidated` toast, bell notification, journal LIQUIDATED badge |
| TP/SL | Untouched | The position's triggers are canceled (`position_closed`) and so are its resting TP/SL limit orders (PR 7). |
| Stale feed | Pair paused, `SKIPPED_STALE` row | Same: never liquidates on a stale book or the ticker. |

Margin warnings (`position.margin_warning` below 25% health) and the `mark.price` events run in both modes.

## 1. Before you switch

Each check below is read-only.

1. **PR 7 is deployed.** Migration 100 has run:
   ```sql
   SELECT id FROM schema_migrations WHERE id LIKE '100%';
   SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' AND column_name IN ('reduce_only', 'close_reason');
   ```
   Both return rows. Without PR 7, a resting TP/SL limit order can still open a position after a liquidation.

2. **Review everything log-only would have done.** From `apps/api`, with `DATABASE_URL` set to prod:
   ```
   pnpm leverage:liq-report --since <date you set log_only>
   ```
   Check:
   - `inconsistent 0`. A non-zero value means a row's mark doesn't breach its own liq price, which is a bug. Stop and investigate; the command exits 1 in that case.
   - For each `LOG_ONLY` row: the liq price matches what the position card showed for that position, to the cent.
   - `→ execute:` numbers look right: P&L ≈ qty × (mark − entry), the fee is about 5 bps of qty × mark, and returned ≈ margin + P&L − fee.
   - **`STILL OPEN` rows.** Execute closes these within about a second of the switch, if they still breach at the mark then. Decide per row: close it yourself first, or let it go (that's the test).
   - `% past`: how far past the liq price the mark was when the engine saw it. Large values on `LOG_ONLY` rows mean late detection (feed gaps or event-loop lag). Check `tradr_liquidation_eval_lag_ms`.
   - `SKIPPED_STALE` count: how often the feed was stale while a position was past its liq price.

3. **Find what would close at once.** Open ISOLATED positions and their liq prices:
   ```sql
   SELECT u.email, tp.symbol, p.base_qty, p.leverage, p.avg_entry_price, p.liq_price, p.isolated_margin,
          p.match_id, p.competition_id
   FROM positions p
   JOIN users u ON u.id = p.user_id
   JOIN trading_pairs tp ON tp.id = p.pair_id
   WHERE p.margin_mode = 'ISOLATED' AND p.base_qty <> 0
   ORDER BY tp.symbol, p.liq_price;
   ```
   Compare each liq price with the current mark: the position card's MARK, which shows the same book mid the engine uses. A long with `liq_price` ≥ mark, or a short with `liq_price` ≤ mark, closes on the first confirmed evaluation.

4. **The feed is healthy.** Over the last 24 h:
   - gauge `tradr_liquidation_paused{pair}` is 0 for BTC, ETH and SOL most of the time;
   - logs `liquidation_paused_stale_feed` / `liquidation_resumed` are rare and the pauses are short (`pausedMs`).

   A pair that pauses often gets liquidated late, and the loss cap absorbs the gap.

5. **One engine is evaluating.** In the API logs, find `Liquidation engine started` with `mode: "log_only"`, and `liquidation_would_fire` lines from one instance only. Evaluation is leader-only (advisory lock `LOCK_NAMES.liquidation`). A second engine can't double-liquidate, because the matching engine re-checks under its locks.

6. **Allowlist and caps are what you expect.** `LEVERAGE_ALLOWLIST` lists only your accounts. `LEVERAGE_MAX_FREE_PLAY` / `LEVERAGE_MAX_MATCH` are unchanged.

## 2. Switch

On the API service (`crypto-platform`), set `LIQUIDATION_MODE=execute` and let it redeploy. The mode is read at startup.

Within a minute, the logs should show `Liquidation engine started` with `mode: "execute"`.

## 3. What to watch after

**First hour.**

- Logs:
  - `liquidation_executed`: one per liquidation, with fill price, P&L, fee, returned equity, shortfall and book age.
  - `liquidation_noop`: fine. The position moved or closed between the decision and the lock.
  - `liquidation_execute_error`: should be **0**. Each one is retried after 5 s.
  - `liquidation_shortfall_absorbed`: a gap past bankruptcy. Expected to be rare.
  - `liquidation_paused_stale_feed` / `liquidation_resumed`.
  - `margin_warning`.
- Metrics:
  - `tradr_liquidations_total{mode="EXECUTED"}`
  - `tradr_liquidation_eval_lag_ms`: p99 well under 1 s.
  - `tradr_liquidation_eval_duration_ms`
  - `tradr_liquidation_paused`
  - `tradr_margin_warnings_total`

**After each liquidation** (read-only):
```sql
-- What it booked
SELECT created_at, user_id, side, qty, entry_price, liq_price, mark_price, fill_price,
       realized_pnl, fee, returned_equity, shortfall, book_age_ms
FROM liquidations WHERE mode = 'EXECUTED' ORDER BY created_at DESC LIMIT 20;

-- No balance below 0, ever
SELECT w.user_id, a.symbol, w.balance FROM wallets w JOIN assets a ON a.id = w.asset_id WHERE w.balance < 0;

-- Nothing reopened the position afterwards: no fill on that pair/scope after the liquidation
-- other than the user's own new orders.
SELECT o.created_at, o.side, o.type, o.qty_filled, o.source, o.reduce_only, o.status, o.cancel_reason
FROM orders o
WHERE o.user_id = '<user>' AND o.pair_id = '<pair>' AND o.created_at >= '<liquidation time>'::timestamptz - interval '1 minute'
ORDER BY o.created_at;

-- Its TP/SL limit orders were canceled with it
SELECT id, side, limit_price, status, cancel_reason FROM orders
WHERE user_id = '<user>' AND reduce_only AND cancel_reason = 'position_closed' ORDER BY updated_at DESC LIMIT 10;
```

**In the app**, as the liquidated user: the toast ("… liquidated at $…, $… margin returned"), the bell notification, the position card gone, the journal row with the LIQUIDATED badge, and the CSV export's `Close Reason = LIQUIDATION`.

**End-to-end verification.** A 10x long liquidates about 9.5% below entry (SOL about 9%), so a real one needs a real move. Don't raise caps to force one. Either wait for a `STILL OPEN` position from step 1.2 to cross, or keep a small 10x position open on your account and check the next one that does.

## 4. Roll back

Set `LIQUIDATION_MODE=log_only` (or `off`) on `crypto-platform` and let it redeploy.

- Liquidations already executed are final. Nothing reverses them, and they need no repair: each one was an ordinary, fully booked close.
- In `log_only`, positions past their liq price are recorded (`LOG_ONLY`) but stay open. Their eventual close, or match end, still applies the loss cap, so no balance goes negative.
- `off` also stops the margin warnings and the `mark.price` events. The position card then falls back to the ticker for its mark. Prefer `log_only`.
- **Don't use `LEVERAGE_ENABLED=false` as a rollback.** It's not a liquidation switch. There's also a known issue: with the flag off, a new order on a pair whose last position was ISOLATED (now flat) trades SPOT, but the position row stays ISOLATED, so the next close settles it as ISOLATED with no margin. To stop new leverage, set the caps to 1 instead (`LEVERAGE_MAX_FREE_PLAY=1`, `LEVERAGE_MAX_MATCH=1`). The engine keeps protecting positions already open.
