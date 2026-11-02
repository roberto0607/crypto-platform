/**
 * The redesigned open-position card (PositionCard) and the order panel's
 * safety around an open position:
 *   - header: how long the position has been open (hidden when unknown);
 *   - BREAK-EVEN from the position's own fees and the pair's taker fee;
 *   - liq "none" for a 1x long;
 *   - TP / SL on the whole position: set, edit, remove, side-checked;
 *   - "reverse to …": confirmed, one MARKET order of twice the size;
 *   - CLOSE & REVERSE (an order on the other side): a confirm step, never
 *     one click;
 *   - EST. LIQ PRICE for an add is the combined position's.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const flags = vi.hoisted(() => ({ SHOW_LEVERAGE_SELECTOR: true, SHOW_FUNDING_IN_CHART_HEADER: false }));
vi.mock("@/lib/featureFlags", () => flags);

const lev = vi.hoisted(() => ({ info: null as null | Record<string, unknown> }));
vi.mock("@/api/endpoints/leverage", () => ({
  getLeverageInfo: vi.fn(async () => {
    if (!lev.info) throw new Error("unavailable");
    return { data: lev.info };
  }),
}));
vi.mock("@/api/endpoints/trading", () => ({
  getOrderBook: vi.fn(),
  getKrakenBook: vi.fn(),
  getSnapshot: vi.fn(),
  listOrders: vi.fn().mockResolvedValue({ data: { ok: true, orders: [], nextCursor: null } }),
  placeOrder: vi.fn().mockResolvedValue({ data: { ok: true, order: { id: "o1" }, fills: [] } }),
  cancelOrder: vi.fn(),
}));
vi.mock("@/api/endpoints/triggers", () => ({
  listTriggers: vi.fn().mockResolvedValue({ data: { data: [], nextCursor: null } }),
  cancelTrigger: vi.fn().mockResolvedValue({ data: { ok: true } }),
  updateTrigger: vi.fn().mockResolvedValue({ data: { ok: true } }),
  createTrigger: vi.fn().mockResolvedValue({ data: { ok: true } }),
  createOco: vi.fn(),
}));

import { UnifiedOrderPanel } from "@/components/trading/UnifiedOrderPanel";
import ToastProvider from "@/components/ToastProvider";
import { placeOrder } from "@/api/endpoints/trading";
import { createTrigger, updateTrigger, cancelTrigger, listTriggers } from "@/api/endpoints/triggers";
import { useTradingStore } from "@/stores/tradingStore";
import { useAppStore } from "@/stores/appStore";
import type { Position, TradingPair, TriggerOrder } from "@/types/api";

const PAIR: TradingPair = {
  id: "p1", symbol: "BTC/USD", base_asset_id: "a-btc", quote_asset_id: "a-usd", is_active: true,
  fee_bps: 0, maker_fee_bps: 2, taker_fee_bps: 5, trading_enabled: true, created_at: "2026-10-15T00:00:00Z",
};
const info = (over: Record<string, unknown> = {}) => ({
  ok: true, pairId: "p1", enabled: true, marginMode: "ISOLATED", cap: 10, mmrBps: 50,
  positionLeverage: "10.00", blockedBy: null, scope: { competitionId: null, matchId: null }, ...over,
});

const OPENED = new Date(Date.now() - ((3 * 24 + 4) * 60 + 5) * 60_000).toISOString(); // 3d 4h 5m ago

// The brief's example: short 0.0616523 @ 81,100, $500 margin at 10x, $2.50 fees paid.
const ISO_SHORT: Position = {
  user_id: "u1", pair_id: "p1", base_qty: "-0.06165230", avg_entry_price: "81100.00000000",
  realized_pnl_quote: "0", fees_paid_quote: "7.50000000", unrealized_pnl_quote: "0", current_price: "80000",
  updated_at: "2026-10-26T00:00:00Z", margin_mode: "ISOLATED", leverage: "10.00",
  isolated_margin: "500.00000000", liq_price: "88766.16668491", mark_price: "80000", margin_health: "1.0000",
  opened_at: OPENED, position_fees_paid: "2.50000000",
};

// $50 at 10x long from 83,000.
const ISO_LONG: Position = {
  user_id: "u1", pair_id: "p1", base_qty: "0.00602409", avg_entry_price: "83000.00000000",
  realized_pnl_quote: "0", fees_paid_quote: "0.24999973", unrealized_pnl_quote: "0", current_price: "83000",
  updated_at: "2026-10-26T00:00:00Z", margin_mode: "ISOLATED", leverage: "10.00",
  isolated_margin: "49.99994700", liq_price: "75075.37688442", mark_price: "83000", margin_health: "1.0000",
  opened_at: OPENED, position_fees_paid: "0.24999973",
};

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const setPrice = (p: string) =>
  act(() => { useTradingStore.setState({ snapshot: { bid: p, ask: p, last: p, ts: "0", source: "live" } }); });

async function mount(position: Position | null) {
  render(
    <ToastProvider>
      <UnifiedOrderPanel pair={PAIR} position={position} positions={position ? [position] : []} onOrderFilled={() => {}} />
    </ToastProvider>,
  );
  await settle();
}

const trigger = (over: Partial<TriggerOrder>): TriggerOrder => ({
  id: "t1", user_id: "u1", pair_id: "p1", kind: "TAKE_PROFIT_MARKET", side: "BUY", trigger_price: "78000.00000000",
  limit_price: null, qty: "0.06165230", status: "ACTIVE", oco_group_id: null, trailing_offset: null,
  created_at: "", updated_at: "", ...over,
} as TriggerOrder);

beforeEach(() => {
  vi.mocked(placeOrder).mockClear();
  vi.mocked(createTrigger).mockClear();
  vi.mocked(updateTrigger).mockClear();
  vi.mocked(cancelTrigger).mockClear();
  vi.mocked(listTriggers).mockResolvedValue({ data: { data: [], nextCursor: null } } as never);
  flags.SHOW_LEVERAGE_SELECTOR = true;
  lev.info = info();
  useAppStore.setState({
    initialized: true, sseConnectionState: "connected", matchWallets: null,
    wallets: [
      { id: "w-usd", user_id: "u1", asset_id: "a-usd", balance: "10000.00000000", reserved: "0.00000000", created_at: "", updated_at: "" },
    ],
  });
  useTradingStore.setState({
    selectedPairId: "p1", orderType: "MARKET", orderSide: "BUY", qty: "", limitPrice: "", activeTriggers: [],
    snapshot: { bid: "80000", ask: "80000", last: "80000", ts: "0", source: "live" },
  });
});

describe("the card", () => {
  it("header: SHORT, 10x, open 3d 4h; hero P&L and ROE", async () => {
    await mount(ISO_SHORT);
    expect(screen.getByText(/BTC SHORT/)).toBeTruthy();
    expect(screen.getByTestId("pos-open-for").textContent).toBe("open 3d 4h");
    // 0.0616523 × (81,100 − 80,000) = +67.82 on $500 margin
    expect(screen.getByTestId("pos-pnl").textContent).toBe("+$67.82");
    expect(screen.getByTestId("pos-pnl-pct").textContent).toBe("+13.56%ROE");
  });

  it("no opened_at (e.g. a converted position): no open-for", async () => {
    await mount({ ...ISO_SHORT, opened_at: null });
    expect(screen.queryByTestId("pos-open-for")).toBeNull();
  });

  it("liq row: price · distance from the mark (short: (liq − mark) / mark)", async () => {
    await mount(ISO_SHORT);
    // (88,766.17 − 80,000) / 80,000 = 10.96%
    expect(screen.getByTestId("pos-liq").textContent).toBe("$88,766.17 · 11.0% away");
  });

  it("a 1x long: liq none, no distance", async () => {
    await mount({ ...ISO_LONG, leverage: "1.00", isolated_margin: "499.99947000", liq_price: null });
    expect(screen.getByTestId("pos-liq").textContent).toBe("none");
  });

  it("SIZE, MARGIN, BREAK-EVEN ($81,018.94 at the pair's 5 bps) and FEES PAID", async () => {
    await mount(ISO_SHORT);
    expect(screen.getByTestId("pos-size").textContent).toBe("0.06165 BTC · $5,000");
    expect(screen.getByTestId("pos-margin").textContent).toBe("$500.00");
    expect(screen.getByTestId("pos-breakeven").textContent).toBe("$81,018.94");
    expect(screen.getByTestId("pos-fees").textContent).toBe("$2.50");
  });

  it("break-even follows the pair's taker fee", async () => {
    render(
      <ToastProvider>
        <UnifiedOrderPanel pair={{ ...PAIR, taker_fee_bps: 20 }} position={ISO_SHORT} positions={[ISO_SHORT]} onOrderFilled={() => {}} />
      </ToastProvider>,
    );
    await settle();
    // (81,100 × 0.0616523 − 2.5) / (0.0616523 × 1.002)
    expect(screen.getByTestId("pos-breakeven").textContent).toBe("$80,897.65");
  });
});

describe("TP / SL on the position", () => {
  it("+ SET TAKE PROFIT: a reduce trigger for the whole position, closing side", async () => {
    await mount(ISO_SHORT);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ SET TAKE PROFIT" }));
    await user.type(screen.getByLabelText("TAKE PROFIT price"), "78000");
    await user.click(screen.getByRole("button", { name: "SET" }));
    expect(createTrigger).toHaveBeenCalledWith({
      pairId: "p1", kind: "TAKE_PROFIT_MARKET", side: "BUY", triggerPrice: "78000", qty: "0.06165230",
    });
  });

  it("a TP on the wrong side of the mark is refused before any request", async () => {
    await mount(ISO_SHORT);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ SET TAKE PROFIT" }));
    await user.type(screen.getByLabelText("TAKE PROFIT price"), "82000");
    await user.click(screen.getByRole("button", { name: "SET" }));
    expect(screen.getByText("Take profit must be below the mark")).toBeTruthy();
    expect(createTrigger).not.toHaveBeenCalled();
  });

  it("+ SET STOP LOSS above a short's mark", async () => {
    await mount(ISO_SHORT);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ SET STOP LOSS" }));
    await user.type(screen.getByLabelText("STOP LOSS price"), "84000");
    await user.click(screen.getByRole("button", { name: "SET" }));
    expect(createTrigger).toHaveBeenCalledWith(expect.objectContaining({ kind: "STOP_MARKET", side: "BUY", triggerPrice: "84000" }));
  });

  it("a set SL shows its price with edit and remove", async () => {
    useTradingStore.setState({ activeTriggers: [trigger({ id: "sl1", kind: "STOP_MARKET", trigger_price: "84000.00000000" })] });
    vi.mocked(listTriggers).mockResolvedValue({ data: { data: [trigger({ id: "sl1", kind: "STOP_MARKET", trigger_price: "84000.00000000" })], nextCursor: null } } as never);
    await mount(ISO_SHORT);
    expect(screen.getByTestId("pos-sl").textContent).toContain("$84,000.00");
    // PATCH answers with the updated trigger (the store swaps it in).
    vi.mocked(updateTrigger).mockResolvedValueOnce(
      { data: trigger({ id: "sl1", kind: "STOP_MARKET", trigger_price: "85000.00000000" }) } as never);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edit stop loss" }));
    const input = screen.getByLabelText("STOP LOSS price");
    await user.clear(input);
    await user.type(input, "85000");
    await user.click(screen.getByRole("button", { name: "SAVE" }));
    expect(updateTrigger).toHaveBeenCalledWith("sl1", { triggerPrice: "85000" });
    expect(screen.getByTestId("pos-sl").textContent).toContain("$85,000.00");

    await user.click(screen.getByRole("button", { name: "Remove stop loss" }));
    expect(cancelTrigger).toHaveBeenCalledWith("sl1");
  });
});

describe("reverse from the card", () => {
  it("asks first; CONFIRM sends one MARKET order of twice the size at the position's leverage", async () => {
    await mount(ISO_SHORT);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "reverse to long…" }));
    expect(placeOrder).not.toHaveBeenCalled();
    expect(screen.getByTestId("confirm-box").textContent).toContain(
      "This closes your SHORT (+$67.82) and opens a LONG of 0.06165 BTC. Confirm?");
    await user.click(screen.getByRole("button", { name: "REVERSE TO LONG" }));
    expect(vi.mocked(placeOrder).mock.calls[0]![0]).toEqual({
      pairId: "p1", side: "BUY", type: "MARKET", qty: "0.12330460", leverage: 10,
    });
  });

  it("CANCEL sends nothing", async () => {
    await mount(ISO_SHORT);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "reverse to long…" }));
    await user.click(screen.getByRole("button", { name: "CANCEL" }));
    expect(placeOrder).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-box")).toBeNull();
  });
});

describe("CLOSE & REVERSE: never one click", () => {
  async function orderLong(margin: string) {
    const user = userEvent.setup();
    await user.click(screen.getByText("LONG"));
    await user.type(screen.getByPlaceholderText("0.00"), margin);
    await user.click(screen.getByRole("button", { name: "CLOSE & REVERSE" }));
    return user;
  }

  it("bigger than the position: closes it and opens a LONG, after CONFIRM", async () => {
    await mount(ISO_SHORT);
    const user = await orderLong("1000"); // $10,000 notional > $5,000 short
    expect(placeOrder).not.toHaveBeenCalled();
    expect(screen.getByTestId("confirm-box").textContent).toContain(
      "This closes your SHORT (+$67.82) and opens a LONG. Confirm?");
    await user.click(screen.getByRole("button", { name: "CONFIRM" }));
    await settle();
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(placeOrder).mock.calls[0]![0]).toMatchObject({ side: "BUY", type: "MARKET", leverage: 10 });
  });

  it("smaller: says it only reduces", async () => {
    await mount(ISO_SHORT);
    await orderLong("100"); // $1,000 notional
    expect(screen.getByTestId("confirm-box").textContent).toContain(
      "This reduces your SHORT by 0.01250 BTC. It opens no LONG. Confirm?");
  });

  it("changing the amount drops the pending confirm", async () => {
    await mount(ISO_SHORT);
    const user = await orderLong("1000");
    await user.type(screen.getByPlaceholderText("0.00"), "0");
    expect(screen.queryByTestId("confirm-box")).toBeNull();
    expect(screen.getByRole("button", { name: "CLOSE & REVERSE" })).toBeTruthy();
  });

  it("leverage off (SPOT): the same confirm, and the body is the plain order", async () => {
    flags.SHOW_LEVERAGE_SELECTOR = false;
    lev.info = info({ enabled: false, marginMode: "SPOT", cap: 1, positionLeverage: null });
    const { margin_mode: _m, leverage: _l, isolated_margin: _i, liq_price: _q, mark_price: _k, margin_health: _h,
      opened_at: _o, position_fees_paid: _f, ...spot } = ISO_SHORT;
    await mount(spot as Position);
    const user = await orderLong("8000");
    expect(placeOrder).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "CONFIRM" }));
    await settle();
    // $8,000 at 80,000: exactly what the button sent before the confirm step.
    expect(vi.mocked(placeOrder).mock.calls[0]![0]).toEqual({ pairId: "p1", side: "BUY", type: "MARKET", qty: "0.10000000" });
  });
});

describe("EST. LIQ PRICE when adding", () => {
  it("shows the combined position's liq price, not the order's alone", async () => {
    await mount(ISO_LONG);
    setPrice("85000");
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("0.00"), "50"); // +0.00588235 BTC at 85,000, 10x
    // Order alone would be $76,884.42; the position after the add: $75,969.13.
    expect(screen.getByTestId("est-liq").textContent).toBe("$75,969.13");
    expect(screen.getByTestId("est-liq").getAttribute("title")).toContain("your position after this add");
  });

  it("no position: the order alone, as before", async () => {
    lev.info = info({ positionLeverage: null });
    await mount(null);
    setPrice("85000");
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "10x" }));
    await user.type(screen.getByPlaceholderText("0.00"), "50");
    expect(screen.getByTestId("est-liq").textContent).toBe("$76,884.42");
  });
});
