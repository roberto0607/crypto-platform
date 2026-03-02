export type OutboxStatus = "PENDING" | "PROCESSING" | "DONE" | "FAILED";

export type OutboxAggregateType =
  | "ORDER"
  | "TRADE"
  | "INCIDENT"
  | "USER"
  | "REPAIR"
  | "RECON"
  | "SYSTEM";

export interface OutboxEventRow {
  id: string;
  event_type: string;
  aggregate_type: OutboxAggregateType;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  created_at: string;
  processed_at: string | null;
}

export interface OutboxInsertInput {
  event_type: string;
  aggregate_type: OutboxAggregateType;
  aggregate_id?: string | null;
  payload: Record<string, unknown>;
}
