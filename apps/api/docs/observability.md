# Observability — Metric Catalog & PromQL Examples

Added in Phase 10 PR2.

## DB Query Timing

| Metric | Type | Labels | Description |
|---|---|---|---|
| `db_query_total` | Counter | `name` | Total DB queries by operation name |
| `db_query_duration_ms` | Histogram | `name` | DB query latency in milliseconds |
| `db_pool_acquire_duration_ms` | Histogram | — | Time to acquire a client from the PG pool |

### Instrumented Operations

| Name | Repo | Description |
|---|---|---|
| `walletRepo.lockWalletsForUpdate` | walletRepo | SELECT … FOR UPDATE on wallets (batch) |
| `walletRepo.reserveFunds` | walletRepo | UPDATE wallets reserved column |
| `walletRepo.releaseReserved` | walletRepo | UPDATE wallets release reserved |
| `walletRepo.creditWallet.lock` | walletRepo | SELECT … FOR UPDATE (credit tx) |
| `walletRepo.creditWallet.update` | walletRepo | UPDATE balance (credit tx) |
| `walletRepo.creditWallet.ledger` | walletRepo | INSERT ledger entry (credit tx) |
| `walletRepo.debitWallet.lock` | walletRepo | SELECT … FOR UPDATE (debit tx) |
| `walletRepo.debitWallet.update` | walletRepo | UPDATE balance (debit tx) |
| `walletRepo.debitWallet.ledger` | walletRepo | INSERT ledger entry (debit tx) |
| `walletRepo.creditWalletTx.update` | walletRepo | UPDATE balance (in-tx credit) |
| `walletRepo.creditWalletTx.ledger` | walletRepo | INSERT ledger entry (in-tx credit) |
| `walletRepo.debitAvailableTx.select` | walletRepo | SELECT balance/reserved check |
| `walletRepo.debitAvailableTx.update` | walletRepo | UPDATE balance (in-tx debit) |
| `walletRepo.debitAvailableTx.ledger` | walletRepo | INSERT ledger entry (in-tx debit) |
| `walletRepo.consumeReservedAndDebitTx.update` | walletRepo | UPDATE reserved + balance |
| `walletRepo.consumeReservedAndDebitTx.ledger` | walletRepo | INSERT ledger entry |
| `orderRepo.createOrder` | orderRepo | INSERT order |
| `orderRepo.updateOrderFill` | orderRepo | UPDATE order fill qty/status |
| `orderRepo.fetchRestingOrdersBatch` | orderRepo | SELECT resting limit orders |
| `tradeRepo.createTrade` | tradeRepo | INSERT trade |
| `tradeRepo.listTradesByOrderId` | tradeRepo | SELECT trades by order |
| `pairRepo.lockPairForUpdate` | pairRepo | SELECT … FOR UPDATE on trading pair |
| `outboxRepo.insertOutboxEventTx` | outboxRepo | INSERT outbox event |
| `outboxRepo.fetchNextBatch` | outboxRepo | UPDATE … FOR UPDATE SKIP LOCKED |
| `outboxRepo.markDone` | outboxRepo | UPDATE outbox event to DONE |
| `outboxRepo.markFailed` | outboxRepo | UPDATE outbox event to FAILED |
| `eventRepo.getLatestEventHash` | eventRepo | SELECT latest hash from chain |
| `eventRepo.appendEventTx` | eventRepo | INSERT event stream row |

## Lock Contention Sampler

| Metric | Type | Labels | Description |
|---|---|---|---|
| `pg_lock_waiting_total` | Gauge | — | Queries currently waiting on locks |
| `pg_lock_wait_duration_max_seconds` | Gauge | — | Longest current lock wait (seconds) |
| `pg_locked_relation_waits` | Gauge | `relname` | Per-relation lock wait count (top-N) |

### Configuration

| Env Var | Default | Description |
|---|---|---|
| `LOCK_SAMPLER_ENABLED` | `true` (dev) / `false` (prod) | Enable lock sampler |
| `LOCK_SAMPLER_INTERVAL_MS` | `5000` | Polling interval |
| `LOCK_SAMPLER_TOPN` | `10` | Max relations to report |

## HTTP Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `http_requests_total` | Counter | `method`, `route`, `status` | Total HTTP requests |
| `http_request_duration_seconds` | Histogram | `method`, `route`, `status` | Request duration |
| `http_inflight_requests` | Gauge | — | Currently in-flight requests |

## PG Pool Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `pg_pool_total_count` | Gauge | — | Total clients in pool |
| `pg_pool_idle_count` | Gauge | — | Idle clients |
| `pg_pool_waiting_count` | Gauge | — | Clients waiting for connection |
| `db_pool_in_use` | Gauge | — | Clients currently in use |
| `db_pool_acquire_duration_ms` | Histogram | — | Time to acquire client from pool |

## Slow Query Detection

| Env Var | Default | Description |
|---|---|---|
| `DB_SLOW_QUERY_MS` | `200` | Threshold for slow query warning |
| `DB_LOG_SQL_ON_SLOW` | `false` | Include SQL text in slow query logs |

Slow queries emit a structured pino warning with `eventType: "db.slow_query"`.

## PromQL Examples

### Top 5 slowest DB queries (p95)

```promql
topk(5,
  histogram_quantile(0.95,
    sum(rate(db_query_duration_ms_bucket[5m])) by (name, le)
  )
)
```

### Top slow endpoints (p95)

```promql
topk(5,
  histogram_quantile(0.95,
    sum(rate(http_request_duration_seconds_bucket[5m])) by (route, le)
  )
)
```

### DB query rate by operation

```promql
sum(rate(db_query_total[5m])) by (name)
```

### Lock waits over time

```promql
pg_lock_waiting_total
```

### Longest lock wait

```promql
pg_lock_wait_duration_max_seconds
```

### Lock waits by relation

```promql
pg_locked_relation_waits
```

### Pool acquire latency (p99)

```promql
histogram_quantile(0.99,
  sum(rate(db_pool_acquire_duration_ms_bucket[5m])) by (le)
)
```

### Pool utilization ratio

```promql
db_pool_in_use / pg_pool_total_count
```

### HTTP inflight requests

```promql
http_inflight_requests
```

### Outbox lag (pending depth)

```promql
outbox_queue_depth
```

### Order placement latency (p95)

```promql
histogram_quantile(0.95,
  sum(rate(order_placement_latency_ms_bucket[5m])) by (le)
)
```
