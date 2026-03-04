import client from "../client";
import type {
  TriggerOrder,
  TriggerKind,
  OrderSide,
  DecimalString,
  UUID,
} from "@/types/api";

export function createTrigger(params: {
  pairId: UUID;
  kind: TriggerKind;
  side: OrderSide;
  triggerPrice: DecimalString;
  limitPrice?: DecimalString;
  qty: DecimalString;
}) {
  return client.post<{ ok: true; trigger: TriggerOrder }>("/triggers", params);
}

export function listTriggers(params?: {
  pairId?: UUID;
  status?: string;
  cursor?: string;
  limit?: number;
}) {
  return client.get<{ ok: true; triggers: TriggerOrder[]; nextCursor: string | null }>(
    "/triggers",
    { params },
  );
}

export function cancelTrigger(triggerId: UUID) {
  return client.post<{ ok: true; trigger: TriggerOrder }>(
    `/triggers/${triggerId}/cancel`,
  );
}

export function createOco(params: {
  pairId: UUID;
  side: OrderSide;
  qty: DecimalString;
  stopTriggerPrice: DecimalString;
  stopLimitPrice?: DecimalString;
  takeProfitTriggerPrice: DecimalString;
  takeProfitLimitPrice?: DecimalString;
}) {
  return client.post<{ ok: true; triggers: TriggerOrder[] }>("/triggers/oco", params);
}
