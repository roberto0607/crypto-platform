import client from "../client";
import type {
  TradingPair,
  Order,
  Fill,
  OrderBook,
  Snapshot,
  OrderSide,
  OrderType,
  DecimalString,
  UUID,
} from "@/types/api";

export function listPairs() {
  return client.get<{ ok: true; pairs: TradingPair[] }>("/pairs");
}

export function placeOrder(
  params: {
    pairId: UUID;
    side: OrderSide;
    type: OrderType;
    qty: DecimalString;
    limitPrice?: DecimalString;
  },
  idempotencyKey?: string,
) {
  return client.post<{ ok: true; order: Order; fills: Fill[] }>("/orders", params, {
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
  });
}

export function listOrders(params?: {
  pairId?: UUID;
  status?: string;
  cursor?: string;
  limit?: number;
}) {
  return client.get<{ ok: true; orders: Order[]; nextCursor: string | null }>(
    "/orders",
    { params },
  );
}

export function getOrder(orderId: UUID) {
  return client.get<{ ok: true; order: Order }>(`/orders/${orderId}`);
}

export function cancelOrder(orderId: UUID) {
  return client.post<{ ok: true; order: Order }>(`/orders/${orderId}/cancel`);
}

export function getOrderBook(pairId: UUID) {
  return client.get<{ ok: true; book: OrderBook }>(`/pairs/${pairId}/book`);
}

export function getSnapshot(pairId: UUID) {
  return client.get<{ ok: true; snapshot: Snapshot }>(`/pairs/${pairId}/snapshot`);
}
