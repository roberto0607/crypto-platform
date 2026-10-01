import type { Pool } from "pg";

/**
 * Delete rows matching `where` in small, separately-committed batches.
 *
 * Why batches: one big DELETE holds its row locks and its snapshot for the
 * whole statement, writes all of its WAL in one burst (on a near-full
 * volume that burst is what tips it over), and leaves a huge dead-tuple
 * pile for one autovacuum pass. Small batches keep each transaction short,
 * spread WAL out (pauseMs between batches), and let autovacuum reclaim
 * space incrementally.
 *
 * Locking: DELETE takes ROW EXCLUSIVE on the table, which never blocks
 * reads or other writers to different rows. lock_timeout stops a batch
 * from queueing behind DDL (and everything else queueing behind it);
 * statement_timeout bounds any single batch.
 *
 * `table` and `where` are trusted, code-defined SQL — never user input.
 */
export interface BatchDeleteOptions {
  batchSize?: number;
  pauseMs?: number;
  /** Stop after this many batches; the next scheduled run continues. */
  maxBatches?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface BatchDeleteResult {
  deleted: number;
  batches: number;
  /** false when maxBatches or the abort signal stopped it early. */
  complete: boolean;
}

export const DEFAULT_BATCH_SIZE = 5_000;

export async function deleteInBatches(
  pool: Pool,
  table: string,
  where: string,
  params: unknown[],
  opts: BatchDeleteOptions = {},
): Promise<BatchDeleteResult> {
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE));
  const pauseMs = opts.pauseMs ?? 100;
  const maxBatches = opts.maxBatches ?? 200;
  const lockTimeoutMs = Math.floor(opts.lockTimeoutMs ?? 2_000);
  const statementTimeoutMs = Math.floor(opts.statementTimeoutMs ?? 30_000);

  const sql =
    `DELETE FROM ${table} WHERE ctid = ANY(ARRAY(` +
    `SELECT ctid FROM ${table} WHERE ${where} LIMIT ${batchSize}))`;

  let deleted = 0;
  let batches = 0;
  while (batches < maxBatches) {
    if (opts.signal?.aborted) return { deleted, batches, complete: false };

    const client = await pool.connect();
    let n: number;
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
      await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
      const res = await client.query(sql, params);
      await client.query("COMMIT");
      n = res.rowCount ?? 0;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    batches++;
    deleted += n;
    if (n < batchSize) return { deleted, batches, complete: true };
    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return { deleted, batches, complete: false };
}
