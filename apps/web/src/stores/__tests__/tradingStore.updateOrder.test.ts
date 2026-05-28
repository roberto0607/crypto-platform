import { describe, it, expect, beforeEach } from "vitest";
import { useTradingStore } from "@/stores/tradingStore";
import type { Order } from "@/types/api";

// updateOrder is the SSE `order.updated` reducer. The backend emits order
// status "CANCELED" (one L — DB orders_status_check). This guards the
// regression where the reducer checked "CANCELLED" (two L's) and so silently
// failed to prune canceled/filled orders pushed over SSE.

function order(id: string): Order {
  return {
    id,
    user_id: "u1",
    pair_id: "p1",
    side: "BUY",
    type: "LIMIT",
    qty: "1",
    qty_filled: "0",
    limit_price: "100",
    status: "OPEN",
    reserved_amount: "100",
    created_at: "2026-05-27T00:00:00Z",
    updated_at: "2026-05-27T00:00:00Z",
  };
}

describe("tradingStore.updateOrder", () => {
  beforeEach(() => {
    useTradingStore.setState({ openOrders: [order("o1"), order("o2")] });
  });

  it("prunes an order when SSE reports backend status 'CANCELED' (one L)", () => {
    // Discriminator: with the old `=== "CANCELLED"` check this no-ops and o1
    // wrongly persists.
    useTradingStore.getState().updateOrder("o1", "CANCELED", "0");
    expect(useTradingStore.getState().openOrders.map((o) => o.id)).toEqual(["o2"]);
  });

  it("prunes an order when fully FILLED", () => {
    useTradingStore.getState().updateOrder("o2", "FILLED", "1");
    expect(useTradingStore.getState().openOrders.map((o) => o.id)).toEqual(["o1"]);
  });

  it("updates in place (keeps the row) for PARTIALLY_FILLED", () => {
    useTradingStore.getState().updateOrder("o1", "PARTIALLY_FILLED", "0.5");
    const o1 = useTradingStore.getState().openOrders.find((o) => o.id === "o1");
    expect(o1?.status).toBe("PARTIALLY_FILLED");
    expect(o1?.qty_filled).toBe("0.5");
    expect(useTradingStore.getState().openOrders).toHaveLength(2);
  });
});
