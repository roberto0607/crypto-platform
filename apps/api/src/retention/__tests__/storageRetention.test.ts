/**
 * storageRetention.test.ts — storage-budget retention against the real test DB.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { pool } from "../../db/pool";
import { runStorageRetention, type StorageBudget } from "../storageRetention";
import { deleteInBatches } from "../batchDelete";
import { runRetention } from "../retentionService";

const logger = pino({ level: "silent" });
const DAY = 86_400_000;

const BUDGET: StorageBudget = {
  candleDays: { "1m": 30, "5m": 365, "15m": 365 },
  agentRunLogDays: 14,
  outboxDoneDays: 7,
};

describe("runStorageRetention", () => {
  let uid: string;
  let pairId: string;
  let assetIds: string[];

  async function addCandle(tf: string, ageMs: number): Promise<void> {
    await pool.query(
      `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), 1, 1, 1, 1, 1)`,
      [pairId, tf, Math.floor((Date.now() - ageMs) / 60_000) * 60_000],
    );
  }

  async function count(tf: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) n FROM candles WHERE pair_id = $1 AND timeframe = $2`,
      [pairId, tf],
    );
    return Number(rows[0]!.n);
  }

  beforeEach(async () => {
    uid = Math.random().toString(36).slice(2, 7).toUpperCase();
    const { rows: a } = await pool.query<{ id: string }>(
      `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $1, 8), ($2, $2, 2) RETURNING id`,
      [`RT${uid}`, `RQ${uid}`],
    );
    assetIds = a.map((r) => r.id);
    const { rows: p } = await pool.query<{ id: string }>(
      `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active)
       VALUES ($1, $2, $3, false) RETURNING id`,
      [assetIds[0], assetIds[1], `RT${uid}/USD`],
    );
    pairId = p[0]!.id;
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM candles WHERE pair_id = $1`, [pairId]);
    await pool.query(`DELETE FROM trading_pairs WHERE id = $1`, [pairId]);
    await pool.query(`DELETE FROM assets WHERE id = ANY($1)`, [assetIds]);
  });

  it("ages out fine-grained candles per timeframe and keeps coarse ones", async () => {
    await addCandle("1m", 40 * DAY);
    await addCandle("1m", 31 * DAY);
    await addCandle("1m", 1 * DAY);
    await addCandle("5m", 400 * DAY);
    await addCandle("5m", 100 * DAY);
    await addCandle("15m", 366 * DAY);
    await addCandle("15m", 10 * DAY);
    await addCandle("1h", 3000 * DAY);
    await addCandle("1d", 4000 * DAY);
    await addCandle("1w", 4000 * DAY);

    const res = await runStorageRetention(pool, logger, { budget: BUDGET, batch: { pauseMs: 0 } });

    expect(await count("1m")).toBe(1);
    expect(await count("5m")).toBe(1);
    expect(await count("15m")).toBe(1);
    expect(await count("1h")).toBe(1);
    expect(await count("1d")).toBe(1);
    expect(await count("1w")).toBe(1);
    expect(res.candlesDeleted["1m"]).toBeGreaterThanOrEqual(2);
    expect(res.complete).toBe(true);
  });

  it("is capped per run and finishes the backlog on the next run", async () => {
    for (let i = 0; i < 10; i++) await addCandle("1m", (40 + i) * DAY);
    await addCandle("1m", DAY);
    const budget: StorageBudget = { candleDays: { "1m": 30 }, agentRunLogDays: 0, outboxDoneDays: 0 };

    // Only this fixture pair has rows old enough, so the cap bites here.
    const first = await runStorageRetention(pool, logger, {
      budget,
      batch: { batchSize: 3, maxBatches: 2, pauseMs: 0 },
    });
    expect(first.complete).toBe(false);
    expect(await count("1m")).toBe(11 - 6);

    const second = await runStorageRetention(pool, logger, {
      budget,
      batch: { batchSize: 3, maxBatches: 2, pauseMs: 0 },
    });
    expect(second.complete).toBe(true);
    expect(await count("1m")).toBe(1);
  });

  it("prunes agent_run_logs and DONE outbox rows only", async () => {
    const { rows: logs } = await pool.query<{ id: string }>(
      `INSERT INTO agent_run_logs (agent_name, status, created_at)
       VALUES ($1, 'success', now() - interval '20 days'), ($1, 'error', now() - interval '1 day')
       RETURNING id`,
      [`rt-${uid}`],
    );
    const { rows: ob } = await pool.query<{ id: string; status: string }>(
      `INSERT INTO outbox_events (event_type, aggregate_type, status, created_at)
       VALUES ('rt.test', $1, 'DONE',    now() - interval '10 days'),
              ('rt.test', $1, 'PENDING', now() - interval '10 days'),
              ('rt.test', $1, 'FAILED',  now() - interval '10 days'),
              ('rt.test', $1, 'DONE',    now() - interval '1 day')
       RETURNING id::text, status`,
      [`rt-${uid}`],
    );

    await runStorageRetention(pool, logger, { budget: BUDGET, batch: { pauseMs: 0 } });

    const { rows: leftLogs } = await pool.query(`SELECT id FROM agent_run_logs WHERE agent_name = $1`, [`rt-${uid}`]);
    expect(leftLogs.map((r) => r.id)).toEqual([logs[1]!.id]);

    const { rows: leftOb } = await pool.query<{ id: string }>(
      `SELECT id::text FROM outbox_events WHERE aggregate_type = $1 ORDER BY id`,
      [`rt-${uid}`],
    );
    expect(leftOb.map((r) => r.id)).toEqual([ob[1]!.id, ob[2]!.id, ob[3]!.id]);

    await pool.query(`DELETE FROM agent_run_logs WHERE agent_name = $1`, [`rt-${uid}`]);
    await pool.query(`DELETE FROM outbox_events WHERE aggregate_type = $1`, [`rt-${uid}`]);
  });
});

describe("deleteInBatches", () => {
  it("deletes in separate batches and reports completion", async () => {
    const tag = `bd-${Math.random().toString(36).slice(2, 8)}`;
    await pool.query(
      `INSERT INTO agent_run_logs (agent_name, status) SELECT $1, 'success' FROM generate_series(1, 7)`,
      [tag],
    );
    const r = await deleteInBatches(pool, "agent_run_logs", "agent_name = $1", [tag], {
      batchSize: 3,
      pauseMs: 0,
    });
    expect(r).toEqual({ deleted: 7, batches: 3, complete: true });
  });

  it("stops early when the abort signal fires", async () => {
    const tag = `bd-${Math.random().toString(36).slice(2, 8)}`;
    await pool.query(
      `INSERT INTO agent_run_logs (agent_name, status) SELECT $1, 'success' FROM generate_series(1, 5)`,
      [tag],
    );
    const ac = new AbortController();
    ac.abort();
    const r = await deleteInBatches(pool, "agent_run_logs", "agent_name = $1", [tag], { signal: ac.signal });
    expect(r).toEqual({ deleted: 0, batches: 0, complete: false });
    await pool.query(`DELETE FROM agent_run_logs WHERE agent_name = $1`, [tag]);
  });
});

describe("runRetention (legacy steps, now batched)", () => {
  it("still deletes audit_log rows past retention and keeps recent ones", async () => {
    const tag = `rt.audit.${Math.random().toString(36).slice(2, 8)}`;
    await pool.query(
      `INSERT INTO audit_log (action, created_at) VALUES ($1, now() - interval '200 days'), ($1, now())`,
      [tag],
    );
    await runRetention(pool, logger, undefined, { batchSize: 2, pauseMs: 0 });
    const { rows } = await pool.query(`SELECT 1 FROM audit_log WHERE action = $1`, [tag]);
    expect(rows).toHaveLength(1);
    await pool.query(`DELETE FROM audit_log WHERE action = $1`, [tag]);
  });
});
