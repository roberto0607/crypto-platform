import { pool } from "../db/pool";
import { auditLog } from "../audit/log";
import { repairsTotal, repairsPositionsUpdatedTotal, repairsDurationMs } from "../metrics";
import { createRepairRunTx, markRepairRunSuccessTx, markRepairRunFailedTx } from "./repairRepo";
import { computePositionFromTrades, applyPositionRebuildTx } from "./positionRebuildService";
import type { RepairPlan, RepairResult, PairRepairResult } from "./repairTypes";
import { insertOutboxEventTx } from "../outbox/outboxRepo";

/**
 * Discover all distinct pair_ids the user has traded.
 */
async function getUserPairIds(
  client: import("pg").PoolClient,
  userId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ pair_id: string }>(
    `SELECT DISTINCT t.pair_id
     FROM trades t
     LEFT JOIN orders buy_o  ON buy_o.id  = t.buy_order_id
     LEFT JOIN orders sell_o ON sell_o.id = t.sell_order_id
     WHERE buy_o.user_id = $1 OR sell_o.user_id = $1`,
    [userId],
  );
  return rows.map((r) => r.pair_id);
}

/**
 * Run a repair (DRY_RUN or APPLY) for a user's positions.
 *
 * - Transactional per user (single BEGIN/COMMIT wraps all pairs).
 * - Deterministic: replays trades to recompute positions.
 * - Idempotent: running APPLY twice produces the same result.
 */
export async function runRepair(
  plan: RepairPlan,
  startedByAdminId: string,
): Promise<RepairResult> {
  const startMs = performance.now();
  const client = await pool.connect();

  let repairRunId = "";

  try {
    await client.query("BEGIN");

    repairRunId = await createRepairRunTx(client, plan, startedByAdminId);

    // Determine pairs to rebuild
    const pairIds = plan.pairId
      ? [plan.pairId]
      : await getUserPairIds(client, plan.targetUserId);

    const pairs: PairRepairResult[] = [];
    let updatedPositionsCount = 0;
    const notes: string[] = [];

    if (pairIds.length === 0) {
      notes.push("No trades found for user — nothing to rebuild.");
    }

    for (const pairId of pairIds) {
      const computed = await computePositionFromTrades(client, {
        userId: plan.targetUserId,
        pairId,
        toTs: plan.toTs,
      });

      const { applied, diffs } = await applyPositionRebuildTx(client, {
        userId: plan.targetUserId,
        pairId,
        computed,
        mode: plan.mode,
      });

      pairs.push({ pairId, computed, diffs, applied });

      if (applied) {
        updatedPositionsCount++;
      }
    }

    const changedPairsCount = pairs.filter((p) => p.diffs.length > 0).length;

    const summary = {
      changedPairsCount,
      updatedPositionsCount,
      totalPairs: pairIds.length,
      mode: plan.mode,
    };

    await markRepairRunSuccessTx(client, repairRunId, summary);

    // ── Outbox: REPAIR_STARTED ──
    await insertOutboxEventTx(client, {
      event_type: "REPAIR_EVENT",
      aggregate_type: "REPAIR",
      aggregate_id: repairRunId,
      payload: {
        userId: plan.targetUserId,
        repairRunId,
        repairEventType: "REPAIR_STARTED",
      },
    });

    // ── Outbox: REPAIR_APPLIED ──
    await insertOutboxEventTx(client, {
      event_type: "REPAIR_EVENT",
      aggregate_type: "REPAIR",
      aggregate_id: repairRunId,
      payload: {
        userId: plan.targetUserId,
        repairRunId,
        repairEventType: "REPAIR_APPLIED",
        metadata: summary,
      },
    });

    await client.query("COMMIT");

    // Metrics
    const durationMs = performance.now() - startMs;
    repairsTotal.inc({ mode: plan.mode, status: "SUCCESS" });
    repairsPositionsUpdatedTotal.inc(updatedPositionsCount);
    repairsDurationMs.observe(durationMs);

    return {
      repairRunId,
      mode: plan.mode,
      changedPairsCount,
      updatedPositionsCount,
      pairs,
      notes,
    };
  } catch (err) {
    if (repairRunId) {
      try {
        await markRepairRunFailedTx(
          client,
          repairRunId,
          err instanceof Error ? err.message : String(err),
        );
      } catch {
        // best-effort — original error takes priority
      }
    }
    await client.query("ROLLBACK").catch(() => {});

    repairsTotal.inc({ mode: plan.mode, status: "FAILED" });

    throw err;
  } finally {
    client.release();
  }
}
