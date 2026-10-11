import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TriggerOrder } from "@/types/api";

// Real store + real components; only the network layer is mocked.
const cancelTriggerApi = vi.fn();
const updateTriggerApi = vi.fn();
vi.mock("@/api/endpoints/trading", () => ({
  getOrderBook: vi.fn(),
  getKrakenBook: vi.fn(),
  getSnapshot: vi.fn(),
  listOrders: vi.fn().mockResolvedValue({ data: { ok: true, orders: [], nextCursor: null } }),
  placeOrder: vi.fn(),
  cancelOrder: vi.fn(),
}));
vi.mock("@/api/endpoints/triggers", () => ({
  listTriggers: vi.fn().mockResolvedValue({ data: { data: [], nextCursor: null } }),
  cancelTrigger: (id: string) => cancelTriggerApi(id),
  updateTrigger: (id: string, patch: unknown) => updateTriggerApi(id, patch),
  createTrigger: vi.fn(),
  createOco: vi.fn(),
}));

import { useTradingStore } from "@/stores/tradingStore";
import OrderDock from "@/components/trading/OrderDock";
import { triggerCanceledMessage } from "@/components/ToastProvider";

function trigger(overrides: Partial<TriggerOrder> = {}): TriggerOrder {
  return {
    id: "t1",
    user_id: "u1",
    pair_id: "p1",
    kind: "TAKE_PROFIT_MARKET",
    side: "BUY",
    trigger_price: "81500.00000000",
    limit_price: null,
    qty: "0.00059697",
    status: "ACTIVE",
    oco_group_id: null,
    derived_order_id: null,
    fail_reason: null,
    trailing_offset: null,
    trailing_high_water_mark: null,
    created_at: "2026-10-11T16:39:04Z",
    updated_at: "2026-10-11T16:39:04Z",
    ...overrides,
  };
}

beforeEach(() => {
  cancelTriggerApi.mockReset().mockResolvedValue({ data: {} });
  updateTriggerApi.mockReset();
  localStorage.clear();
  useTradingStore.setState({ openOrders: [], activeTriggers: [] });
});

describe("OrderDock — active triggers", () => {
  it("shows triggers with no open orders: dock opens, count includes them, OCO is labeled", () => {
    useTradingStore.setState({
      activeTriggers: [
        trigger({ id: "tp", kind: "TAKE_PROFIT_MARKET", trigger_price: "81500", oco_group_id: "g1" }),
        trigger({ id: "sl", kind: "STOP_MARKET", trigger_price: "85000", oco_group_id: "g1" }),
      ],
    });
    render(<OrderDock />);

    expect(screen.getByText("2")).toBeInTheDocument(); // count badge
    expect(screen.getByText("Take profit")).toBeInTheDocument();
    expect(screen.getByText("Stop loss")).toBeInTheDocument();
    expect(screen.getByText("81,500.00")).toBeInTheDocument();
    expect(screen.getAllByText("OCO")).toHaveLength(2);
    expect(screen.queryByText("No open orders")).not.toBeInTheDocument();
  });

  it("shows a trailing stop's live stop and its offset", () => {
    useTradingStore.setState({
      activeTriggers: [trigger({ kind: "TRAILING_STOP_MARKET", side: "SELL", trigger_price: "83916.43", trailing_offset: "40" })],
    });
    render(<OrderDock />);
    expect(screen.getByText("Trailing stop")).toBeInTheDocument();
    expect(screen.getByText(/trails 40\.00/)).toBeInTheDocument();
  });

  it("Cancel removes the trigger via DELETE /v1/triggers/:id", async () => {
    useTradingStore.setState({ activeTriggers: [trigger({ id: "tp" })] });
    render(<OrderDock />);

    await userEvent.click(screen.getByRole("button", { name: "Cancel Take profit" }));

    expect(cancelTriggerApi).toHaveBeenCalledWith("tp");
    await waitFor(() => expect(screen.queryByText("Take profit")).not.toBeInTheDocument());
  });

  it("a failed cancel puts the trigger back", async () => {
    cancelTriggerApi.mockRejectedValue(new Error("network"));
    useTradingStore.setState({ activeTriggers: [trigger({ id: "tp" })] });
    render(<OrderDock />);

    await userEvent.click(screen.getByRole("button", { name: "Cancel Take profit" }));

    await waitFor(() => expect(screen.getByText("Take profit")).toBeInTheDocument());
    expect(useTradingStore.getState().activeTriggers.map((t) => t.id)).toEqual(["tp"]);
  });
});

describe("tradingStore.updateTrigger", () => {
  it("PATCHes in place and keeps the row (id + OCO link) in the list", async () => {
    useTradingStore.setState({ activeTriggers: [trigger({ id: "tp", oco_group_id: "g1" })] });
    updateTriggerApi.mockResolvedValue({ data: trigger({ id: "tp", oco_group_id: "g1", trigger_price: "80000.00000000" }) });

    await useTradingStore.getState().updateTrigger("tp", { triggerPrice: "80000" });

    expect(updateTriggerApi).toHaveBeenCalledWith("tp", { triggerPrice: "80000" });
    expect(useTradingStore.getState().activeTriggers).toEqual([
      expect.objectContaining({ id: "tp", oco_group_id: "g1", trigger_price: "80000.00000000" }),
    ]);
  });
});

describe("triggerCanceledMessage", () => {
  it("explains server-side cancels in plain words", () => {
    expect(triggerCanceledMessage("position_closed", "abc")).toMatch(/Position closed/);
    expect(triggerCanceledMessage("no_position", "abc")).toMatch(/no order placed/);
    expect(triggerCanceledMessage("oco_sibling_triggered", "abc")).toMatch(/other side/);
    expect(triggerCanceledMessage(undefined, "abcdef1234")).toBe("Trigger canceled: abcdef12");
  });
});
