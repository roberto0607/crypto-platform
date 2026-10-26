/**
 * closed_trades.close_reason (api journal/journalService.ts CloseReason) →
 * the journal's badge. An ordinary close (MANUAL), and trades closed before
 * the server recorded a reason (null), get none.
 */
export function closeReasonBadge(reason: string | null | undefined): { label: string; color: string } | null {
  switch (reason) {
    case "LIQUIDATION": return { label: "LIQUIDATED", color: "#ff3b3b" };
    case "TP": return { label: "TP", color: "#00ff41" };
    case "SL": return { label: "SL", color: "#f59e0b" };
    case "TRAILING": return { label: "TRAILING STOP", color: "#f59e0b" };
    default: return null;
  }
}
