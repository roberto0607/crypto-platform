export type IncidentStatus = "OPEN" | "INVESTIGATING" | "RESOLVED";

export type IncidentSeverity = "HIGH" | "CRITICAL";

export type IncidentEventType =
  | "OPENED"
  | "ACKNOWLEDGED"
  | "NOTE"
  | "REPAIR_STARTED"
  | "REPAIR_APPLIED"
  | "RECON_CLEAN"
  | "RECON_FAILED"
  | "UNQUARANTINE_ATTEMPT"
  | "RESOLVED";

export interface IncidentRow {
  id: string;
  user_id: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  opened_by: string;
  opened_reason: string;
  recon_run_id: string | null;
  latest_report_id: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_summary: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface IncidentEventRow {
  id: string;
  incident_id: string;
  event_type: IncidentEventType;
  actor_user_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ProofPack {
  user: {
    id: string;
    email: string;
    role: string;
    accountStatus: string;
  };
  incidents: IncidentRow[];
  incidentEvents: IncidentEventRow[];
  reconciliationReports: unknown[];
  repairRuns: unknown[];
  orders: unknown[];
  trades: unknown[];
  ledgerEntries: unknown[];
  positions: unknown[];
  equitySnapshots: unknown[];
  truncated: Record<string, boolean>;
  generatedAt: string;
}
