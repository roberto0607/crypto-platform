export type Severity = "INFO" | "WARN" | "HIGH";

export interface ReconFinding {
  severity: Severity;
  checkName: string;
  userId: string | null;
  details: Record<string, unknown>;
}

export interface ReconRunResult {
  runId: string;
  findingsCount: number;
  highCount: number;
  warnCount: number;
  quarantinedUserIds: string[];
}
