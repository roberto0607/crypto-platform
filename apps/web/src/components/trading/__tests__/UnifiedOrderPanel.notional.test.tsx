/**
 * Order size is exactly the amount entered (2026-10-15). The 1x-10x buttons
 * never applied leverage — they multiplied qty into a bigger spot order, so a
 * $50 entry at "10x" placed a $500 order. They are hidden until real leverage
 * UI ships, and the sizing math no longer multiplies by anything.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const flags = vi.hoisted(() => ({ SHOW_LEVERAGE_SELECTOR: false }));
vi.mock("@/lib/featureFlags", () => flags);

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
  cancelTrigger: vi.fn(),
  updateTrigger: vi.fn(),
  createTrigger: vi.fn(),
  createOco: vi.fn(),
}));

import { UnifiedOrderPanel } from "@/components/trading/UnifiedOrderPanel";
import ToastProvider from "@/components/ToastProvider";
import { placeOrder } from "@/api/endpoints/trading";
import { useTradingStore } from "@/stores/tradingStore";
import { useAppStore } from "@/stores/appStore";
import type { TradingPair } from "@/types/api";

const PRICE = 83950;

const PAIR: TradingPair = {
  id: "p1",
  symbol: "BTC/USD",
  base_asset_id: "a-btc",
  quote_asset_id: "a-usd",
  is_active: true,
  fee_bps: 0,
  maker_fee_bps: 2,
  taker_fee_bps: 5,
  trading_enabled: true,
  created_at: "2026-10-15T00:00:00Z",
};

beforeEach(() => {
  vi.mocked(placeOrder).mockClear();
  flags.SHOW_LEVERAGE_SELECTOR = false;
  useAppStore.setState({ initialized: true, sseConnectionState: "connected" });
  useTradingStore.setState({
    selectedPairId: "p1",
    orderType: "MARKET",
    activeTriggers: [],
    snapshot: { bid: String(PRICE), ask: String(PRICE), last: String(PRICE), ts: "0", source: "live" },
  });
});

/**
 * Render, pick 10x if the selector is shown, enter $50, submit; return the
 * notional sent. qty is 8-dp base units, so compare to the cent.
 */
async function submitFiftyDollars(): Promise<number> {
  render(
    <ToastProvider>
      <UnifiedOrderPanel pair={PAIR} position={null} onOrderFilled={() => {}} />
    </ToastProvider>,
  );
  const user = userEvent.setup();
  const tenX = screen.queryByText("10x");
  if (tenX) await user.click(tenX);
  await user.type(screen.getByPlaceholderText("0.00"), "50");
  await user.click(screen.getByRole("button", { name: /OPEN LONG/ }));

  expect(placeOrder).toHaveBeenCalledTimes(1);
  const { qty } = vi.mocked(placeOrder).mock.calls[0]![0];
  return parseFloat(qty) * PRICE;
}

describe("UnifiedOrderPanel order notional", () => {
  it("hides the leverage selector by default", () => {
    render(
      <ToastProvider>
        <UnifiedOrderPanel pair={PAIR} position={null} onOrderFilled={() => {}} />
      </ToastProvider>,
    );
    for (const lv of ["1x", "2x", "3x", "5x", "10x"]) {
      expect(screen.queryByText(lv)).toBeNull();
    }
  });

  it("entering $50 submits $50 notional", async () => {
    expect(await submitFiftyDollars()).toBeCloseTo(50, 2);
  });

  it("entering $50 submits $50 notional even with the selector shown and 10x picked", async () => {
    flags.SHOW_LEVERAGE_SELECTOR = true;
    expect(await submitFiftyDollars()).toBeCloseTo(50, 2);
  });
});
