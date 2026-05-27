/**
 * simCandleRepo.integration.test.ts — INTEGRATION test (real Postgres, slow).
 *
 * Why integration, not unit: the fix is about a query PLAN / index behavior on a
 * large table — `getLatestSimCandle` pins `timeframe='1m'` so the lookup is an
 * index seek instead of a full-table Parallel Seq Scan that grows with the
 * candles table. A mock can't exercise that; only a real Postgres with a large,
 * indexed candles table proves it. Spins an ephemeral postgres:16 via
 * testcontainers (mirrors the redisQueue integration test). Run with
 * `pnpm test:integration`.
 *
 * Regression coverage for: docs/designs/2026-05-27-candles-query-index.md
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import { getLatestSimCandle } from "../simCandleRepo";

// A pair with a large, multi-timeframe candle history (the realistic case that
// made the timeframe-less query slow), and a pair that has NO 1m candles (only
// coarser data) to exercise the null-fallback contract.
const PAIR_BIG = "11111111-1111-1111-1111-111111111111";
const PAIR_NO_1M = "22222222-2222-2222-2222-222222222222";
const TS_BOUND = "2099-01-01T00:00:00Z"; // after all seeded candles → matches the latest

let container: StartedPostgreSqlContainer;
let pool: Pool;

describe("getLatestSimCandle — 1m-pinned, index-served (integration, real Postgres; regression for candles seq-scan)", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });

    // Minimal candles schema matching prod's relevant shape + indexes.
    await pool.query(`
      CREATE TABLE candles (
        pair_id   uuid        NOT NULL,
        timeframe text        NOT NULL,
        ts        timestamptz NOT NULL,
        open      numeric     NOT NULL,
        high      numeric     NOT NULL,
        low       numeric     NOT NULL,
        close     numeric     NOT NULL,
        volume    numeric     NOT NULL,
        PRIMARY KEY (pair_id, timeframe, ts)
      );
      CREATE INDEX idx_candles_lookup ON candles (pair_id, timeframe, ts DESC);
    `);

    // Seed ~200k rows for PAIR_BIG across timeframes — enough that a timeframe-less
    // seq scan is clearly slow (>5ms), while the 1m index seek stays sub-ms.
    const seed = (tf: string, n: number, stepMin: number) => pool.query(
      `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
       SELECT $1, $2,
              TIMESTAMPTZ '2020-01-01' + (g * $3 || ' minutes')::interval,
              100, 101, 99, 100, 10
       FROM generate_series(1, $4) g`,
      [PAIR_BIG, tf, stepMin, n],
    );
    await seed("1m", 150_000, 1);
    await seed("1h", 30_000, 60);
    await seed("4h", 30_000, 240);
    // PAIR_NO_1M: only 1h candles, no 1m → exercises the null-fallback contract.
    await pool.query(
      `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
       SELECT $1, '1h', TIMESTAMPTZ '2020-01-01' + (g * 60 || ' minutes')::interval, 100,101,99,100,10
       FROM generate_series(1, 1000) g`,
      [PAIR_NO_1M],
    );

    // Stats so the planner picks the index for the pinned query (and seq scan for
    // the timeframe-less one).
    await pool.query("ANALYZE candles");
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  // PRIMARY: latency. Proves the fix regardless of which index the planner picks
  // (robust across PG version upgrades, unlike a plan-shape assertion).
  it("returns the latest 1m candle in under 5ms on a ~200k-row table", async () => {
    // Warm up (plan cache / connection), then measure the median of several runs.
    await getLatestSimCandle(PAIR_BIG, TS_BOUND, pool);

    const samples: number[] = [];
    for (let i = 0; i < 11; i++) {
      const t0 = performance.now();
      const candle = await getLatestSimCandle(PAIR_BIG, TS_BOUND, pool);
      samples.push(performance.now() - t0);
      expect(candle).not.toBeNull(); // it found a 1m candle
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    expect(median).toBeLessThan(5);
  });

  // Q1 contract: a pair with no 1m candle returns null (no throw) → callers fall
  // back to default sim params. We now rely on this since we pin to 1m.
  it("returns null (no throw) when the pair has no 1m candle", async () => {
    const candle = await getLatestSimCandle(PAIR_NO_1M, TS_BOUND, pool);
    expect(candle).toBeNull();
  });

  // BONUS signal: the pinned query is index-served, not a seq scan.
  it("uses an index scan, not a Seq Scan (bonus plan check)", async () => {
    const { rows } = await pool.query(
      `EXPLAIN (FORMAT JSON)
       SELECT volume, high, low FROM candles
       WHERE pair_id = $1 AND timeframe = '1m' AND ts <= $2
       ORDER BY ts DESC LIMIT 1`,
      [PAIR_BIG, TS_BOUND],
    );
    const plan = JSON.stringify(rows[0]["QUERY PLAN"]);
    expect(plan).not.toContain("Seq Scan");
    expect(plan).toContain("Index"); // Index Scan / Index Only Scan
  });
});
