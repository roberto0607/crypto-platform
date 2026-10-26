/**
 * Order size (2026-10-15, updated for real leverage in PR 6b). The old 1x-10x
 * buttons multiplied qty into a bigger SPOT order ($50 at "10x" placed a $500
 * spot order). That path is gone:
 *   - SPOT (leverage off): the order is exactly the amount entered, and the
 *     selector isn't shown even with the client switch on.
 *   - ISOLATED with a cap above 1x (the server says so): the amount is the
 *     margin, and the order carries `leverage` — the engine locks the margin
 *     and the notional is margin × L. Never a bigger spot order.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const flags = vi.hoisted(() => ({ SHOW_LEVERAGE_SELECTOR: true }));
vi.mock("@/lib/featureFlags", () => flags);

const lev = vi.hoisted(() => ({ info: null as null | Record<string, unknown> }));
vi.mock("@/api/endpoints/leverage", () => ({
  getLeverageInfo: vi.fn(async () => ({ data: lev.info })),
}));
const SPOT = { ok: true, pairId: "p1", enabled: false, marginMode: "SPOT", cap: 1, mmrBps: 50, positionLeverage: null, blockedBy: null, scope: { competitionId: null, matchId: null } };

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
  flags.SHOW_LEVERAGE_SELECTOR = true;
  lev.info = SPOT;
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
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
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
  it("SPOT: no leverage selector, even with the client switch on", async () => {
    render(
      <ToastProvider>
        <UnifiedOrderPanel pair={PAIR} position={null} onOrderFilled={() => {}} />
      </ToastProvider>,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    for (const lv of ["1x", "2x", "3x", "5x", "10x"]) {
      expect(screen.queryByText(lv)).toBeNull();
    }
  });

  it("SPOT: entering $50 submits $50 notional, no leverage field", async () => {
    expect(await submitFiftyDollars()).toBeCloseTo(50, 2);
    expect(vi.mocked(placeOrder).mock.calls[0]![0]).not.toHaveProperty("leverage");
  });

  it("ISOLATED, 10x picked: $50 is the margin; the $500 notional goes with leverage 10 (never a bigger spot order)", async () => {
    lev.info = { ...SPOT, enabled: true, marginMode: "ISOLATED", cap: 10 };
    expect(await submitFiftyDollars()).toBeCloseTo(500, 0);
    expect(vi.mocked(placeOrder).mock.calls[0]![0]).toMatchObject({ leverage: 10 });
  });

  it("the client switch off: no selector and no leverage, whatever the server allows", async () => {
    flags.SHOW_LEVERAGE_SELECTOR = false;
    lev.info = { ...SPOT, enabled: true, marginMode: "ISOLATED", cap: 10 };
    expect(await submitFiftyDollars()).toBeCloseTo(50, 2);
    expect(vi.mocked(placeOrder).mock.calls[0]![0]).not.toHaveProperty("leverage");
  });
});
