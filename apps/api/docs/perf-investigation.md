# Performance Investigation — Phase 10 PR3

Hot-path bottleneck analysis based on PR1 baseline metrics and PR2 observability data.

---

## Top 3 Slow DB Queries

### 1. Order Book Aggregate Queries (GET /pairs/:id/book)

- **File**: `src/routes/tradingRoutes.ts:183-215`
- **Query** (x2, bids + asks):
  ```sql
  SELECT limit_price AS price,
         SUM(qty - qty_filled)::text AS qty,
         COUNT(*)::text AS count
  FROM orders
  WHERE pair_id = $1
    AND side = 'BUY'          -- or 'SELL'
    AND type = 'LIMIT'
    AND status IN ('OPEN', 'PARTIALLY_FILLED')
  GROUP BY limit_price
  ORDER BY limit_price DESC   -- or ASC
  LIMIT $2
  ```
- **Frequency**: Every book request (highest-frequency read endpoint, ~70% of mixed traffic)
- **Baseline p95**: ~35ms (estimated from read_heavy scenario)
- **SLO target**: p95 < 150ms
- **Issues**:
  1. NOT wrapped in `timedQuery` — invisible to PR2 observability
  2. Two queries executed sequentially — could be parallelized
  3. GROUP BY forces row-level scan even with partial index coverage
- **Indexes used**: `idx_orders_book_buy` / `idx_orders_book_sell` (migration 008) cover WHERE + ORDER but aggregation still scans matching rows

### 2. Counter-Party Wallet Lookups (N x 2 sequential)

- **File**: `src/trading/matchingEngine.ts:223-224`
- **Query** (called 2x per fill entry):
  ```sql
  SELECT id, user_id, asset_id, balance, reserved, created_at, updated_at
  FROM wallets
  WHERE user_id = $1 AND asset_id = $2
  LIMIT 1
  ```
- **Frequency**: 2 calls per fill (10 fills = 20 DB round-trips)
- **Baseline p95**: <1ms each, but ~10-20ms cumulative for multi-fill orders
- **Issues**:
  1. NOT wrapped in `timedQuery` — invisible to observability
  2. Sequential execution accumulates round-trip latency
- **Index used**: UNIQUE constraint `wallets_user_asset_unique (user_id, asset_id)` — point lookup is fast individually

### 3. debitAvailableTx Redundant SELECT

- **File**: `src/wallets/walletRepo.ts:308-313`
- **Query**: `SELECT balance, reserved FROM wallets WHERE id = $1` followed by separate `UPDATE`
- **Frequency**: 1 per MARKET fill (taker side)
- **Baseline p95**: <1ms per query, but 3 round-trips where 2 would suffice
- **Issue**: SELECT reads balance for availability check, then UPDATE modifies it. Can be merged into conditional UPDATE with `WHERE (balance - reserved) >= $1`

---

## Top 2 Lock Contention Sources

### 1. Pair Lock (PRIMARY serialization point)

- **File**: `src/trading/pairRepo.ts:81-93`
- **Query**: `SELECT ... FROM trading_pairs WHERE id = $1 FOR UPDATE`
- **Hold duration**: Entire placeOrder transaction (Phase A through COMMIT)
- **Baseline**: order_placement_ms p95 = 72ms → max ~14 OPS per pair
- **Impact**: All order placement and cancellation for a pair serializes here
- **Decision**: Do NOT change lock strategy (correctness). Reduce time inside lock instead.

### 2. Wallet Locks (secondary)

- **File**: `src/wallets/walletRepo.ts:225-246`
- **Query**: `SELECT ... FROM wallets WHERE id = ANY($1) ORDER BY id FOR UPDATE`
- **Contention level**: Low — only fires for cross-pair shared wallets
- **Impact**: Minimal at current load (pair lock already serializes within-pair)

---

## SLO Status at Baseline

| Endpoint | SLO Target | Baseline p95 | Margin |
|---|---|---|---|
| POST /orders | < 250ms | 72ms | 3.5x |
| GET /pairs/:id/book | < 150ms | ~35ms | 4x (untracked!) |
| GET /wallets, /pairs | < 100ms | ~35ms | 3x |
| Outbox lag | < 5s | 39ms | 128x |

All within SLO at baseline. Optimizations target throughput ceiling and observability gaps.

---

## Optimization Plan

### Index Additions (migration 033)

| Index | Table | Columns | Justification |
|---|---|---|---|
| `idx_orders_user_created` | orders | `(user_id, created_at DESC, id DESC)` | Covers `listOrdersByUserIdPaginated` sort without filesort |
| `idx_ledger_wallet_created` | ledger_entries | `(wallet_id, created_at DESC)` | Covers wallet history sort |
| `idx_trades_pair_executed` | trades | `(pair_id, executed_at DESC)` | Covers trade history by pair sort |
| `idx_ledger_reference` | ledger_entries | `(reference_id) WHERE reference_id IS NOT NULL` | Covers post-trade invariant check join |

### Query Shape Changes

| Change | File | Impact |
|---|---|---|
| Parallelize book bids+asks with `Promise.all` | tradingRoutes.ts | ~50% book endpoint latency reduction |
| Wrap book queries in `timedQuery` | tradingRoutes.ts | Observability |
| Batch counter-party wallet lookup | matchingEngine.ts | 2N → 1 query |
| Merge SELECT+UPDATE in `debitAvailableTx` | walletRepo.ts | 3 → 2 round-trips per MARKET fill |
| Wrap `findWalletByUserAndAsset` in `timedQuery` | walletRepo.ts | Observability |
| Wrap `findOrderByIdForUpdate` in `timedQuery` | orderRepo.ts | Observability |

### Pool Tuning

| Setting | Before | After | Rationale |
|---|---|---|---|
| `max` | 10 (hardcoded) | 20 (env `DB_POOL_MAX`) | Headroom for higher VU load tests |
