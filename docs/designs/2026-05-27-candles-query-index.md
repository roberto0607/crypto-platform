# Design: fix the per-MARKET-order candles seq scan (pin timeframe='1m')

**Status:** proposed (awaiting approval) · **Date:** 2026-05-27 · **Author:** trade_burst regression investigation
**Tracks:** `docs/followups.md` → "trade_burst order placement p95 2.8× slower than March"

## Problem

`placeOrderWithSnapshot` runs this on **every MARKET order** (`phase6OrderService.ts`, the MARKET branch), feeding the slippage/liquidity sim:

```sql
SELECT volume, high, low FROM candles
 WHERE pair_id = $1 AND ts <= $2 ORDER BY ts DESC LIMIT 1
```

It filters `pair_id` + `ts` but **omits `timeframe`**, while both candle indexes lead with
`(pair_id, timeframe, ts)`. With no `timeframe` predicate the index can't seek, so:

```
BEFORE:  Parallel Seq Scan on candles  (scans ~211k rows) + top-N sort
         Execution Time: 18.9 ms   (Buffers: shared hit=3747)
```

That ~19ms is the bulk of the measured ~25ms per-order exec (`pair_queue_exec_ms`). Under
trade_burst's single-pair, 10-VU load the in-memory queue serializes orders, so ~25ms/order ×
pile-up = **~254ms p95** (median stays ~60ms — it's a tail).

The query is **byte-identical to March** (`git show 35aa84a:…` == now), so this is not a code
regression — it's **data growth**: the startup backfill keeps adding candles (BTC/USD alone: 139k×1h,
103k×1m, …). Same seq scan, vastly more rows → March 72ms → 2026-05-26 201ms → 2026-05-27 253ms,
worsening each restart. (The originally-suspected `getActiveMatchIdForUser` query was **refuted**:
0.016ms, fully indexed — wrong table.)

## Chosen fix (one line)

Add `AND timeframe = '1m'`:

```sql
SELECT volume, high, low FROM candles
 WHERE pair_id = $1 AND timeframe = '1m' AND ts <= $2 ORDER BY ts DESC LIMIT 1
```

```
AFTER:   Index Scan Backward using candles_pkey on candles
         Index Cond: (pair_id = … AND timeframe = '1m' AND ts <= now())
         Execution Time: 0.295 ms   (Buffers: 4)        ── ~64× faster
```

**Why `1m` specifically** (see also the trail in `followups.md`):
- The candle is a **current-market-state** input — `volume` → available liquidity *right now*
  (`computeAvailableLiquidity` = `min(maxPerTick, volume×price)`); `high`/`low` → *current* volatility
  for spread widening (`range/last`). Both want the **finest, freshest** bar; a 1h/4h volume (60×–1440×
  a 1m bar) would massively overstate per-moment liquidity.
- `SimulationConfig` has **no timeframe field** — the timeframe is implicit in the query, not configurable.
- **Behavior-preserving in the normal case:** the existing no-filter `ORDER BY ts DESC LIMIT 1` already
  resolves to the 1m candle, because 1m always has the most-recent boundary. Verified per-timeframe
  latest-ts: `1m 19:16` > `5m 19:10` > `15m 19:00` > `1h 18:00` > `4h 16:00` > `1d` (prior day). Pinning
  `1m` returns the *same row* — just via a 1-row index seek instead of a 211k-row scan. It also removes a
  latent bug: today, if the 1m feed lags, a coarser timeframe's (much larger) volume silently wins and
  distorts the sim. Pinned `1m` is deterministic.

No index change needed — `candles_pkey`/`idx_candles_lookup` already cover the prefix. No `maxQueueDepth`
or schema change.

## Q1 — Failure mode: what if the 1m candle query returns zero rows?

Traced the call path; **it degrades safely, no crash / no NaN** — and this is already by design:

1. `phase6OrderService.ts`: `const candle = candleRows[0] ?? null;` → zero rows ⇒ `candle = null`.
2. It passes `candle?.volume ?? null`, `candle?.high ?? null`, `candle?.low ?? null` into the sim.
3. `computeAvailableLiquidity(config, null, last)` → `if (!candleVolume) return maxPerTick` ⇒ returns
   `config.liquidity_quote_per_tick` (default **500,000**).
4. `computeMarketExecution`: `availableLiquidityQuote = max(MIN_LIQUIDITY 10_000, 500_000) = 500_000`.
   A normal order (< $500k notional) passes; `if (candleHigh && candleLow)` is false ⇒ **no volatility
   widening**, uses `base_spread_bps`. `execPrice` computes from `last ± base spread/slippage`.
5. Only a > $500k order returns `null` ⇒ `insufficient_liquidity` (400) — identical to today's behavior.

The existing code comment (MARKET branch) already documents this: *"computeMarketExecution handles null
volume/high/low … falls back to default simulation … rather than rejecting orders on pairs with no candle
history."* So a pair **missing 1m specifically** takes the same safe path a pair with **no candles at all**
takes today. Direction is *more permissive* (full liquidity quota vs volume-derived), never a failure.

**No gap — but** we're newly relying on this fallback for the "1m-missing" case, so the test plan adds an
explicit assertion that a MARKET order on a pair with no 1m candle still places (locks the contract).

## Q2 — Pair coverage: do all active prod pairs have 1m candles?

**Yes — verified against the prod DB** (`railway run --service Postgres … DATABASE_PUBLIC_URL`, read-only):

| Pair | 1m rows | latest 1m ts |
|---|---|---|
| BTC/USD | 103,746 | 2026-05-27 19:29:00Z |
| ETH/USD | 103,746 | 2026-05-27 19:29:00Z |
| SOL/USD | 103,746 | 2026-05-27 19:29:00Z |

All three active pairs have abundant, **fresh-to-the-minute** 1m data. The fix breaks no active pair; in
prod the fallback in Q1 won't even trigger. (Note: the **local** dev DB only has BTC/USD candles — a local
backfill artifact — so local MARKET orders on ETH/SOL exercise the Q1 fallback. Good for testing that path,
but not representative of prod coverage.)

## Test strategy

Integration test against **real Postgres** (index/EXPLAIN behavior can't be mocked — same rationale as the
XLEN PR's testcontainers test). Open question below on the pg harness.

1. **Plan assertion (the fix):** seed a pair with a mix of timeframes (e.g. a few thousand `1m` + some
   `1h`/`4h`), then `EXPLAIN (FORMAT JSON)` the pinned query and assert the scan node is an **Index Scan on
   `candles`** (accept either `candles_pkey` or `idx_candles_lookup`) and assert **no `Seq Scan` on candles**.
2. **Discriminator (mirrors XLEN PR):** `EXPLAIN` the *old* no-timeframe query against the same data and
   assert it **does** seq-scan — proving the test discriminates the bug, not a coincidental pass.
3. **Q1 contract:** a MARKET order (or a direct `computeMarketExecution` call) with **no 1m candle** for the
   pair still produces a valid execution price (fallback: maxPerTick liquidity, base spread) and does **not**
   throw / NaN. Confirms the failure mode we now depend on.
4. (Cheap) confirm existing `slippageModel`/`liquidityModel` unit tests already cover null volume/high/low;
   add a case if not.

## Migration risk

- **Schema: none.** Uses existing indexes; no DDL.
- **Behavioral change worth documenting:** the sim now **strictly** reads the latest `1m` bar instead of
  "latest bar of any timeframe." In the normal case these are identical (1m is always freshest). They differ
  only if the 1m feed lags behind coarser feeds — then old code used a coarser (larger-volume) candle, new
  code uses the latest 1m (or the safe fallback if 1m is absent). For active prod pairs (fresh 1m) there is
  no practical change. No backfill / no data migration.

## Expected impact

- Candle query: **18.9ms → 0.30ms** (~64×), per the captured plans.
- Per-order exec (`pair_queue_exec_ms`): **~25ms → ~6ms**.
- trade_burst 10-VU p95: **~254ms → toward ~72ms** (March), since the single-pair serialization multiplies a
  much smaller per-order cost. Also stops the slow drift-over-time (cost no longer scales with candle count).
- Verify post-merge with a trade_burst re-run (expect p95 back near March) and `pair_queue_exec_ms` ~6ms.

## Q3 — PR-body story (the diagnostic journey, so the PR writes itself)

Same shape as the XLEN PR — a hypothesis that was wrong, corrected by measurement:

1. **Symptom:** trade_burst order placement p95 3× slower than March (72 → 201 → 253ms), now grazing the
   250ms SLO. "Placing orders has to feel instant."
2. **First hypothesis (refuted):** the `getActiveMatchIdForUser` lookup PR #26 added at the HTTP edge —
   suspected unindexed seq scan on `matches`. `EXPLAIN ANALYZE`: **0.016ms, fully indexed**. Wrong table.
3. **1-VU control run:** p95 collapsed ~254ms → ~55ms; `pair_queue_wait_ms` ≈ 0 at 1 VU. So the tail is
   **concurrency pile-up through the single-pair queue**, not per-order cost in isolation — but per-order
   *exec* (~25ms) is what the serialization multiplies.
4. **Hot-path diff (March→now):** the per-MARKET-order candles query is **byte-identical** to March → not a
   code change. `EXPLAIN`: **Parallel Seq Scan of 211k candles, 18.9ms**, because the query omits `timeframe`
   and no index serves `(pair_id, ts)`. The table grew via the startup backfill → same query, far slower,
   worse each restart.
5. **Fix:** pin `timeframe='1m'` → index seek, 0.30ms. It's the row the query already returned, just fast and
   deterministic.
6. **Why it matters / honesty note:** invisible at low load + masked by a healthy median; surfaced only under
   concurrent load because single-pair serialization amplifies per-order cost. Corrected the original
   `followups.md` hypothesis rather than hiding it.

## Decisions / open questions

- Is there a Postgres integration-test harness (testcontainers pg, or reuse the dev docker pg) for the plan
  assertion? The Redis test uses `@testcontainers/redis`; confirm/добавить `@testcontainers/postgresql` or run
  the EXPLAIN against the dev DB in `test:integration`.
- OK to keep the fix to the single `phase6OrderService` query, or also audit for other `FROM candles … ORDER BY
  ts` queries with the same timeframe-less shape? (Quick grep before implementing — out of scope unless found.)
