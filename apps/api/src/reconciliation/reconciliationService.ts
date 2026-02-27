import { reconcileWallets } from "./walletReconciliation";
import { reconcileFees } from "./feeReconciliation";
import { reconcilePositions } from "./positionReconciliation";
import {
  reconciliationRunsTotal,
  reconciliationFailuresTotal,
  reconciliationWalletMismatches,
  reconciliationPositionMismatches,
  reconciliationRunLatency,
  reconciliationStatusGauge,
} from "../metrics";
import { pool } from "../db/pool";
import { checkReconciliationBreaker } from "../risk/breakerService";
import { auditLog } from "../audit/log";
import { logger } from "../observability/logContext";

// ── Types ──

import type { WalletReconciliationReport } from "./walletReconciliation";
import type { FeeReconciliationReport } from "./feeReconciliation";
import type { PositionReconciliationReport } from "./positionReconciliation";

export type ReconciliationStatus = "OK" | "WARNING" | "CRITICAL";

export interface FullReconciliationReport {
  timestamp: string;
  walletReport: WalletReconciliationReport;
  feeReport: FeeReconciliationReport;
  positionReport: PositionReconciliationReport;
  overallStatus: ReconciliationStatus;
}

// ── Severity logic ──

function deriveStatus(
  walletReport: WalletReconciliationReport,
  feeReport: FeeReconciliationReport,
  positionReport: PositionReconciliationReport,
): ReconciliationStatus {
  if (
    walletReport.mismatchedWallets.length > 0 ||
    walletReport.invalidReservedWallets.length > 0 ||
    positionReport.mismatchedPositions.length > 0
  ) {
    return "CRITICAL";
  }

  if (
    feeReport.mismatchedFees.length > 0 ||
    feeReport.negativeFees.length > 0 ||
    feeReport.missingFeeEntries.length > 0 ||
    positionReport.anomalies.length > 0
  ) {
    return "WARNING";
  }

  return "OK";
}

// ── Orchestrator ──

export async function runFullReconciliation(): Promise<FullReconciliationReport> {
  const startMs = performance.now();
  reconciliationRunsTotal.inc();
  logger.info({ eventType: "reconciliation.started" }, "Reconciliation run started");

  try {
    const [walletReport, feeReport, positionReport] = await Promise.all([
      reconcileWallets(),
      reconcileFees(),
      reconcilePositions(),
    ]);

    // Increment mismatch counters
    if (walletReport.mismatchedWallets.length > 0) {
      reconciliationWalletMismatches.inc(walletReport.mismatchedWallets.length);
    }
    if (positionReport.mismatchedPositions.length > 0) {
      reconciliationPositionMismatches.inc(positionReport.mismatchedPositions.length);
    }

    const overallStatus = deriveStatus(walletReport, feeReport, positionReport);

    // Update status gauge (set current to 1, others to 0)
    for (const s of ["OK", "WARNING", "CRITICAL"] as const) {
      reconciliationStatusGauge.set({ status: s }, s === overallStatus ? 1 : 0);
    }

    // Trip circuit breaker if CRITICAL
    if (overallStatus === "CRITICAL") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await checkReconciliationBreaker(client, overallStatus);
        await client.query("COMMIT");
      } catch (breakerErr) {
        await client.query("ROLLBACK").catch(() => {});
        logger.error({ eventType: "reconciliation.breaker_error", err: breakerErr }, "Failed to trip reconciliation breaker");
      } finally {
        client.release();
      }
    }

    const latencyMs = performance.now() - startMs;
    reconciliationRunLatency.observe(latencyMs);
    logger.info({ eventType: "reconciliation.complete", overallStatus, latencyMs: Math.round(latencyMs) }, "Reconciliation run complete");

    // Write audit entry so /health/deep can query last status
    await auditLog({
      actorUserId: null,
      action: "reconciliation.run",
      targetType: "reconciliation",
      metadata: { overallStatus, latencyMs: Math.round(latencyMs) },
    });

    return {
      timestamp: new Date().toISOString(),
      walletReport,
      feeReport,
      positionReport,
      overallStatus,
    };
  } catch (err) {
    reconciliationFailuresTotal.inc();
    reconciliationRunLatency.observe(performance.now() - startMs);
    logger.error({ eventType: "reconciliation.failed", err }, "Reconciliation run failed");
    throw err;
  }
}

