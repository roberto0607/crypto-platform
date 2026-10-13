/**
 * In an ACTIVE match, every order trades that match's own wallets (API
 * migration 095), so AVAILABLE must come from them — never free-play cash.
 * Outside a match it's free-play.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";

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
const getMatchWallets = vi.fn();
vi.mock("@/api/endpoints/matches", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/endpoints/matches")>()),
  getMatchWallets: (id: string) => getMatchWallets(id),
}));

import { UnifiedOrderPanel } from "@/components/trading/UnifiedOrderPanel";
import ToastProvider from "@/components/ToastProvider";
import { useTradingStore } from "@/stores/tradingStore";
import { useAppStore } from "@/stores/appStore";
import { useActiveMatchStore } from "@/stores/activeMatchStore";
import type { TradingPair, Wallet } from "@/types/api";
import type { Match } from "@/api/endpoints/matches";

const PAIR = {
  id: "p-btc", symbol: "BTC/USD", base_asset_id: "a-btc", quote_asset_id: "a-usd",
  is_active: true, fee_bps: 0, maker_fee_bps: 2, taker_fee_bps: 5, trading_enabled: true,
  created_at: "2026-10-11T00:00:00Z",
} as TradingPair;

const wallet = (id: string, asset_id: string, balance: string, reserved = "0") =>
  ({ id, user_id: "u1", asset_id, balance, reserved, created_at: "", updated_at: "" }) as Wallet;

const MATCH = { id: "m1", status: "ACTIVE" } as Match;

beforeEach(() => {
  getMatchWallets.mockReset();
  useAppStore.setState({
    pairs: [PAIR],
    wallets: [wallet("f-usd", "a-usd", "100000"), wallet("f-btc", "a-btc", "0")],
    matchWallets: null,
  });
  useActiveMatchStore.setState({ activeMatch: null, isInCompetition: false });
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

describe("AVAILABLE follows the account the order trades", () => {
  it("outside a match: free-play", () => {
    renderPanel();
    expect(screen.getByText("$100,000.00 USD")).toBeTruthy();
    expect(getMatchWallets).not.toHaveBeenCalled();
  });

  it("in an ACTIVE match: the match wallets (2× rule on them), never free-play", async () => {
    getMatchWallets.mockResolvedValue({
      data: { ok: true, wallets: [wallet("m-usd", "a-usd", "50025"), wallet("m-btc", "a-btc", "-0.0005")] },
    });
    useActiveMatchStore.setState({ activeMatch: MATCH, isInCompetition: true });
    renderPanel();

    // While the match wallets load, AVAILABLE is unknown — not free-play's 100k.
    expect(screen.queryByText("$100,000.00 USD")).toBeNull();
    await waitFor(() => expect(screen.getByText("$49,975.00 USD")).toBeTruthy());
    expect(getMatchWallets).toHaveBeenCalledWith("m1");

    // wallet.updated for a match wallet patches the match set.
    act(() => useAppStore.getState().applyWalletUpdate({ walletId: "m-usd", balance: "50050", reserved: "0" }));
    expect(screen.getByText("$50,000.00 USD")).toBeTruthy();
    // ...and leaves free-play alone.
    expect(useAppStore.getState().wallets.find((w) => w.id === "f-usd")!.balance).toBe("100000");
  });

  it("after the match ends, back to free-play", async () => {
    getMatchWallets.mockResolvedValue({ data: { ok: true, wallets: [wallet("m-usd", "a-usd", "50000")] } });
    useActiveMatchStore.setState({ activeMatch: MATCH, isInCompetition: true });
    renderPanel();
    await waitFor(() => expect(screen.getByText("$50,000.00 USD")).toBeTruthy());

    act(() => useActiveMatchStore.setState({ activeMatch: null, isInCompetition: false }));
    await waitFor(() => expect(screen.getByText("$100,000.00 USD")).toBeTruthy());
    expect(useAppStore.getState().matchWallets).toBeNull();
  });
});
