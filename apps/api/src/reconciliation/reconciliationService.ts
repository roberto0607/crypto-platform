import { reconcileWallets } from "./walletReconciliation";
import { reconcileFees } from "./feeReconciliation";
import { reconcilePositions } from "./positionReconciliation";
import {
  reconciliationRunsTotal,
  reconciliationFailuresTotal,
  reconciliationWalletMismatches,
  reconciliationPositionMismatches,
} from "../metrics";
import { pool } from "../db/pool";
import { checkReconciliationBreaker } from "../risk/breakerService";

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
  reconciliationRunsTotal.inc();

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

    // Trip circuit breaker if CRITICAL
    if (overallStatus === "CRITICAL") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await checkReconciliationBreaker(client, overallStatus);
        await client.query("COMMIT");
      } catch (breakerErr) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("Failed to trip reconciliation breaker:", breakerErr);
      } finally {
        client.release();
      }
    }

    return {
      timestamp: new Date().toISOString(),
      walletReport,
      feeReport,
      positionReport,
      overallStatus,
    };
  } catch (err) {
    reconciliationFailuresTotal.inc();
    throw err;
  }
}
