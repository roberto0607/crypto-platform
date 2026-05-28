import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Order } from "@/types/api";

// Mock only the API layer so the real store + real components run (true
// reactivity), but cancelOrder doesn't hit the network. `cancelOrderApi` is the
// spy we assert against.
const cancelOrderApi = vi.fn();
vi.mock("@/api/endpoints/trading", () => ({
  getOrderBook: vi.fn(),
  getKrakenBook: vi.fn(),
  getSnapshot: vi.fn(),
  listOrders: vi.fn().mockResolvedValue({ data: { ok: true, orders: [], nextCursor: null } }),
  placeOrder: vi.fn(),
  cancelOrder: (id: string) => cancelOrderApi(id),
}));

import { useTradingStore } from "@/stores/tradingStore";
import OrderDock from "@/components/trading/OrderDock";

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "o1",
    user_id: "u1",
    pair_id: "p1",
    side: "BUY",
    type: "LIMIT",
    qty: "0.00133137",
    qty_filled: "0",
    limit_price: "75110.70",
    status: "OPEN",
    reserved_amount: "100.30",
    created_at: "2026-05-27T20:38:07Z",
    updated_at: "2026-05-27T20:38:07Z",
    ...overrides,
  };
}

beforeEach(() => {
  cancelOrderApi.mockReset().mockResolvedValue({ data: { ok: true } });
  localStorage.clear();
  useTradingStore.setState({ openOrders: [] });
});

describe("OrderDock", () => {
  it("renders a row per open order with side + limit price, and a count badge", () => {
    useTradingStore.setState({
      openOrders: [
        order({ id: "o1", side: "BUY", limit_price: "75110.70" }),
        order({ id: "o2", side: "SELL", limit_price: "76000.00" }),
      ],
    });
    render(<OrderDock />);

    expect(screen.getByText("75,110.70")).toBeInTheDocument();
    expect(screen.getByText("76,000.00")).toBeInTheDocument();
    expect(screen.getByText("BUY")).toBeInTheDocument();
    expect(screen.getByText("SELL")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // count badge
  });

  it("shows the thin strip (no table) with a non-toggleable bar when there are 0 open orders", () => {
    useTradingStore.setState({ openOrders: [] });
    render(<OrderDock />);

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /expand open orders/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("auto-expands when orders appear (0→N), overriding a stored collapsed pref", async () => {
    // Reproduces Issue 1: a prior manual collapse left "collapsed" in localStorage.
    localStorage.setItem("tradr_order_dock", "collapsed");
    useTradingStore.setState({ openOrders: [] });
    render(<OrderDock />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument(); // 0 orders → thin

    // Orders arrive (e.g. fetched on load / placed). Discriminator: without the
    // auto-expand effect, the stored "collapsed" keeps the dock thin and hides them.
    act(() => {
      useTradingStore.setState({
        openOrders: [order({ id: "o1", limit_price: "75110.70" }), order({ id: "o2", limit_price: "76000.00" })],
      });
    });

    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByText("75,110.70")).toBeInTheDocument();
    expect(screen.getByText("76,000.00")).toBeInTheDocument();
  });

  it("auto-expands on first mount when orders are already present, despite stored collapse", () => {
    localStorage.setItem("tradr_order_dock", "collapsed");
    useTradingStore.setState({ openOrders: [order({ id: "o1" })] });
    render(<OrderDock />);
    // Entering the page with open orders must never show a thin dock.
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("toggles the dock when the header label is clicked (whole bar is the target)", async () => {
    const user = userEvent.setup();
    useTradingStore.setState({ openOrders: [order({ id: "o1" })] });
    render(<OrderDock />);
    expect(screen.getByRole("table")).toBeInTheDocument(); // auto-expanded

    // Issue 2 discriminator: click the "Open Orders" label, NOT the chevron. With the
    // old chevron-only handler this did nothing; now it bubbles to the bar → collapse.
    await user.click(screen.getByText("Open Orders"));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    await user.click(screen.getByText("Open Orders"));
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("cancels an order: calls DELETE with the order id and removes the row", async () => {
    const user = userEvent.setup();
    useTradingStore.setState({ openOrders: [order({ id: "ord-xyz", limit_price: "75110.70" })] });
    render(<OrderDock />);
    expect(screen.getByText("75,110.70")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(cancelOrderApi).toHaveBeenCalledWith("ord-xyz");
    await waitFor(() => expect(screen.queryByText("75,110.70")).not.toBeInTheDocument());
  });
});
