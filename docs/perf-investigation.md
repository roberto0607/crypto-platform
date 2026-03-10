# Performance Investigation — Phase 10 PR3

Hot-path bottleneck analysis based on PR1 baseline metrics and PR2 observability data.

---

## Top 3 Slow DB Queries

### 1. Order Book Aggregate Queries (GET /pairs/:id/book)

- **File**: `src/routes/tradingRoutes.ts:183-215`
- **Query** (×2, bids + asks):
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
