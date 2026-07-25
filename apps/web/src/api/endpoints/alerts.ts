import client from "../client";
import type {
  Alert,
  AlertConditionType,
  AlertFrequency,
  DecimalString,
  UUID,
} from "@/types/api";

export function createAlert(params: {
  pairId: UUID;
  conditionType: AlertConditionType;
  targetValue: DecimalString;
  frequency: AlertFrequency;
  frequencyMinutes?: number;
  expiration?: string;
  messageTemplate?: string;
  channels?: string[];
}) {
  return client.post<Alert>("/v1/alerts", params);
}

export function listAlerts(params?: {
  pairId?: UUID;
  status?: string;
  cursor?: string;
  limit?: number;
}) {
  return client.get<{ data: Alert[]; nextCursor: string | null }>(
    "/v1/alerts",
    { params },
  );
}

export function cancelAlert(alertId: UUID) {
  return client.delete<Alert>(`/v1/alerts/${alertId}`);
}
