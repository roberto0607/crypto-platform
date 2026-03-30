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
  trailingOffset?: DecimalString;
}) {
  return client.post<TriggerOrder>("/triggers", params);
}

export function listTriggers(params?: {
  pairId?: UUID;
  status?: string;
  cursor?: string;
  limit?: number;
}) {
  return client.get<{ data: TriggerOrder[]; nextCursor: string | null }>(
    "/triggers",
    { params },
  );
}

export function cancelTrigger(triggerId: UUID) {
  return client.delete<TriggerOrder>(`/triggers/${triggerId}`);
}

export function createOco(params: {
  pairId: UUID;
  legA: {
    kind: TriggerKind;
    side: OrderSide;
    triggerPrice: DecimalString;
    limitPrice?: DecimalString;
    qty: DecimalString;
    trailingOffset?: DecimalString;
  };
  legB: {
    kind: TriggerKind;
    side: OrderSide;
    triggerPrice: DecimalString;
    limitPrice?: DecimalString;
    qty: DecimalString;
    trailingOffset?: DecimalString;
  };
}) {
  return client.post<{ ocoGroupId: string; legA: TriggerOrder; legB: TriggerOrder }>("/oco", params);
}
