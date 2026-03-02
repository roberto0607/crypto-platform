export type EventType =
  | "ORDER_PLACED"
  | "TRADE_EXECUTED"
  | "USER_QUARANTINED"
  | "USER_UNQUARANTINED"
  | "INCIDENT_OPENED"
  | "INCIDENT_ACKNOWLEDGED"
  | "INCIDENT_RESOLVED"
  | "REPAIR_STARTED"
  | "REPAIR_APPLIED"
  | "RECON_RUN_COMPLETED";

export type EntityType =
  | "ORDER"
  | "TRADE"
  | "USER"
  | "INCIDENT"
  | "REPAIR"
  | "RECON"
  | "SYSTEM";

export interface EventStreamRow {
  id: string;
  event_type: EventType;
  entity_type: EntityType;
  entity_id: string | null;
  actor_user_id: string | null;
  payload: Record<string, unknown>;
  previous_event_hash: string;
  event_hash: string;
  created_at: string;
}

export interface EventInput {
  eventType: EventType;
  entityType: EntityType;
  entityId?: string | null;
  actorUserId?: string | null;
  payload: Record<string, unknown>;
}
