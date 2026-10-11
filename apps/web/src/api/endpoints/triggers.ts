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
  return client.post<TriggerOrder>("/v1/triggers", params);
}

export function listTriggers(params?: {
  pairId?: UUID;
  status?: string;
  cursor?: string;
  limit?: number;
}) {
  return client.get<{ data: TriggerOrder[]; nextCursor: string | null }>(
    "/v1/triggers",
    { params },
  );
}

export function cancelTrigger(triggerId: UUID) {
  return client.delete<TriggerOrder>(`/v1/triggers/${triggerId}`);
}

/** Edit an ACTIVE trigger in place: triggerPrice (stop/TP) or trailingOffset (trailing stop). Keeps its OCO link. */
export function updateTrigger(
  triggerId: UUID,
  patch: { triggerPrice?: DecimalString; trailingOffset?: DecimalString },
) {
  return client.patch<TriggerOrder>(`/v1/triggers/${triggerId}`, patch);
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
  return client.post<{ ocoGroupId: string; legA: TriggerOrder; legB: TriggerOrder }>("/v1/oco", params);
}
