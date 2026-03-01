import { randomUUID } from "node:crypto";
import { pool } from "../db/pool";
import { logger } from "../observability/logContext";
import { reconFindingsTotal, reconQuarantinesTotal } from "../metrics";
import { insertFindingsTx } from "./reconRepo";
import { quarantineUsersTx } from "./quarantineService";
import { walletLedgerCheck } from "./checks/walletLedgerCheck";
import { reservedVsOrdersCheck } from "./checks/reservedVsOrdersCheck";
import { tradeConservationCheck } from "./checks/tradeConservationCheck";
import { idempotencyIntegrityCheck } from "./checks/idempotencyIntegrityCheck";
import { positionsVsTradesCheck } from "./checks/positionsVsTradesCheck";
import type { ReconFinding, ReconRunResult } from "./reconTypes";

/**
 * Run all reconciliation checks, persist findings, quarantine users with HIGH findings.
 */
export async function runReconciliation(): Promise<ReconRunResult> {
  const runId = randomUUID();
  const startMs = performance.now();

  logger.info({ eventType: "recon.started", runId }, "Reconciliation run started");

  // 1. Run all checks in parallel
  const results = await Promise.allSettled([
    walletLedgerCheck(),
    reservedVsOrdersCheck(),
    tradeConservationCheck(),
    idempotencyIntegrityCheck(),
    positionsVsTradesCheck(),
  ]);

  // Collect findings, log any check failures
  const findings: ReconFinding[] = [];
  const checkNames = [
    "walletLedgerCheck",
    "reservedVsOrdersCheck",
    "tradeConservationCheck",
    "idempotencyIntegrityCheck",
    "positionsVsTradesCheck",
  ];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      findings.push(...result.value);
    } else {
      logger.error(
        { eventType: "recon.check_failed", runId, check: checkNames[i], err: result.reason },
        `Reconciliation check failed: ${checkNames[i]}`,
      );
    }
  }

  // 2. Compute counts
  const highCount = findings.filter((f) => f.severity === "HIGH").length;
  const warnCount = findings.filter((f) => f.severity === "WARN").length;

  // 3. Update metrics
  for (const f of findings) {
    reconFindingsTotal.inc({ check: f.checkName, severity: f.severity });
  }

  // 4. Persist findings + quarantine in a single transaction
  const userIdsToQuarantine = [
    ...new Set(
      findings
        .filter((f) => f.severity === "HIGH" && f.userId !== null)
        .map((f) => f.userId as string),
    ),
  ];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await insertFindingsTx(client, runId, findings);

    if (userIdsToQuarantine.length > 0) {
      await quarantineUsersTx(client, userIdsToQuarantine, "Reconciliation drift detected", runId);
      reconQuarantinesTotal.inc(userIdsToQuarantine.length);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error({ eventType: "recon.persist_failed", runId, err }, "Failed to persist reconciliation findings");
    throw err;
  } finally {
    client.release();
  }

  const latencyMs = performance.now() - startMs;

  logger.info(
    {
      eventType: "recon.complete",
      runId,
      findingsCount: findings.length,
      highCount,
      warnCount,
      quarantinedUserIds: userIdsToQuarantine,
      latencyMs: Math.round(latencyMs),
    },
    "Reconciliation run complete",
  );

  return {
    runId,
    findingsCount: findings.length,
    highCount,
    warnCount,
    quarantinedUserIds: userIdsToQuarantine,
  };
}
