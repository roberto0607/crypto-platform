# Performance Baseline — Phase 10 PR3

## Pre-optimization (from PR1 baseline, SHA 35aa84a)

| Scenario | p50 | p95 | p99 | RPS/OPS | Error % |
|---|---|---|---|---|---|
| auth_smoke | — | 43ms | — | — | 0.00% |
| read_heavy | — | 35ms | — | 175 | 0.00% |
| trade_burst | — | 64ms | — | 9 OPS | 0.00% |
| mixed_realistic | — | 41ms | — | 47 | 0.22% |
| outbox_pressure | — | 42ms | — | 22 | 0.00% |

## Post-optimization

| Scenario | p50 | p95 | p99 | RPS/OPS | Error % | Notes |
|---|---|---|---|---|---|---|
| auth_smoke | | | | | | |
| read_heavy | | | | | | |
| trade_burst | | | | | | |
| mixed_realistic | | | | | | |
| outbox_pressure | | | | | | |

## Comparison

| Scenario | p95 Before | p95 After | Improvement % |
|---|---|---|---|
| auth_smoke | 43ms | | |
| read_heavy | 35ms | | |
| trade_burst | 64ms | | |
| mixed_realistic | 41ms | | |

## DB Query p95 Changes

| Query Name | Before | After | Change |
|---|---|---|---|
| book.bids | (untracked) | | Now tracked |
| book.asks | (untracked) | | Now tracked |
| matchingEngine.batchCounterWallets | N/A | | New (replaces N*2 calls) |
| walletRepo.debitAvailableTx.update | | | Merged select+update |
| walletRepo.findWalletByUserAndAsset | (untracked) | | Now tracked |
| orderRepo.findOrderByIdForUpdate | (untracked) | | Now tracked |

## Lock Wait Metrics

| Metric | Before | After |
|---|---|---|
| pair lock hold time (avg) | | |
| wallet lock wait (avg) | | |

## Outbox Lag

| Metric | Before | After |
|---|---|---|
| outbox p95 processing | 39ms | |
| queue depth peak | 50 | |
