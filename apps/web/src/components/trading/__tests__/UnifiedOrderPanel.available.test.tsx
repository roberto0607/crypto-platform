/**
 * AVAILABLE = buying power (QA F5, 2026-10-11). After a $50 short the USD
 * wallet holds the proceeds (100,050), but AVAILABLE showed — and MAX used —
 * the whole 100,050. It now shows the same 99,950 a $50 long would leave, and
 * moves with price and wallet.updated without a reload.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
  cancelTrigger: vi.fn(),
  updateTrigger: vi.fn(),
  createTrigger: vi.fn(),
  createOco: vi.fn(),
}));

import { UnifiedOrderPanel } from "@/components/trading/UnifiedOrderPanel";
import ToastProvider from "@/components/ToastProvider";
import { useTradingStore } from "@/stores/tradingStore";
import { useAppStore } from "@/stores/appStore";
import { usePairPricesStore } from "@/stores/pairPricesStore";
import type { TradingPair, Wallet } from "@/types/api";

const PAIR = {
  id: "p-btc", symbol: "BTC/USD", base_asset_id: "a-btc", quote_asset_id: "a-usd",
  is_active: true, fee_bps: 0, maker_fee_bps: 2, taker_fee_bps: 5, trading_enabled: true,
  created_at: "2026-10-11T00:00:00Z",
} as TradingPair;
const ETH = { ...PAIR, id: "p-eth", symbol: "ETH/USD", base_asset_id: "a-eth" } as TradingPair;

const wallet = (asset_id: string, balance: string, reserved = "0") =>
  ({ id: `w-${asset_id}`, user_id: "u1", asset_id, balance, reserved, created_at: "", updated_at: "" }) as Wallet;

beforeEach(() => {
  useAppStore.setState({ pairs: [PAIR, ETH] });
  usePairPricesStore.setState({ prices: { "p-eth": 2500 } });
  useTradingStore.setState({
    selectedPairId: "p-btc",
    activeTriggers: [],
    snapshot: { bid: "50000", ask: "50000", last: "50000", ts: "0", source: "live" },
  });
});

const renderPanel = () =>
  render(
    <ToastProvider>
      <UnifiedOrderPanel pair={PAIR} position={null} onOrderFilled={() => {}} />
    </ToastProvider>,
  );

describe("AVAILABLE after a short", () => {
  it("shows cash minus 2× the short, and MAX uses it", async () => {
    useAppStore.setState({ wallets: [wallet("a-usd", "100050"), wallet("a-btc", "-0.001")] });
    renderPanel();

    expect(screen.getByText("$99,950.00 USD")).toBeTruthy();
    await userEvent.setup().click(screen.getByText("MAX"));
    expect((screen.getByPlaceholderText("0.00") as HTMLInputElement).value).toBe("99950");
  });

  it("is marked to market: a short losing value lowers it, live", () => {
    useAppStore.setState({ wallets: [wallet("a-usd", "175000"), wallet("a-btc", "-1.5")] });
    renderPanel();
    expect(screen.getByText("$25,000.00 USD")).toBeTruthy();

    act(() => {
      useTradingStore.setState({ snapshot: { bid: "70000", ask: "70000", last: "70000", ts: "1", source: "live" } });
    });
    expect(screen.getByText("-$35,000.00 USD")).toBeTruthy();
  });

  it("counts a short on another pair at that pair's price", () => {
    useAppStore.setState({ wallets: [wallet("a-usd", "125000"), wallet("a-btc", "0"), wallet("a-eth", "-10")] });
    renderPanel();
    expect(screen.getByText("$75,000.00 USD")).toBeTruthy();
  });

  it("follows wallet.updated without a reload", () => {
    useAppStore.setState({ wallets: [wallet("a-usd", "100000"), wallet("a-btc", "0")] });
    renderPanel();
    expect(screen.getByText("$100,000.00 USD")).toBeTruthy();

    act(() => useAppStore.getState().applyWalletUpdate({ walletId: "w-a-usd", balance: "99949.26", reserved: "0" }));
    expect(screen.getByText("$99,949.26 USD")).toBeTruthy();
  });
});
