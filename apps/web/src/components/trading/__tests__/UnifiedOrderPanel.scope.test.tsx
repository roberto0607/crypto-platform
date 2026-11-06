/**
 * MATCH | PRACTICE from the browser's side: every write names the scope on
 * screen, the panel shows that scope's money, and nothing typed for one scope
 * can be sent to the other.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const lev = vi.hoisted(() => ({ getLeverageInfo: vi.fn() }));
vi.mock("@/api/endpoints/leverage", () => lev);
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
vi.mock("@/api/endpoints/quote", () => ({
  getMarketQuote: vi.fn().mockRejectedValue(new Error("no quote in this test")),
}));
const getMatchWallets = vi.fn();
vi.mock("@/api/endpoints/matches", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/endpoints/matches")>()),
  getMatchWallets: (id: string) => getMatchWallets(id),
}));

import { placeOrder } from "@/api/endpoints/trading";
import { createTrigger, createOco } from "@/api/endpoints/triggers";
import { UnifiedOrderPanel } from "@/components/trading/UnifiedOrderPanel";
import ToastProvider from "@/components/ToastProvider";
import { useTradingStore } from "@/stores/tradingStore";
import { useAppStore } from "@/stores/appStore";
import { useActiveMatchStore } from "@/stores/activeMatchStore";
import type { Position, TradingPair, Wallet } from "@/types/api";
import type { Match } from "@/api/endpoints/matches";

const PAIR = {
  id: "p-btc", symbol: "BTC/USD", base_asset_id: "a-btc", quote_asset_id: "a-usd",
  is_active: true, fee_bps: 0, maker_fee_bps: 2, taker_fee_bps: 5, trading_enabled: true,
  created_at: "2026-10-11T00:00:00Z",
} as TradingPair;
const wallet = (id: string, asset_id: string, balance: string) =>
  ({ id, user_id: "u1", asset_id, balance, reserved: "0", created_at: "", updated_at: "" }) as Wallet;
const MATCH = { id: "m1", status: "ACTIVE", opponent_name: "bob" } as Match;
const POSITION = {
  user_id: "u1", pair_id: "p-btc", base_qty: "0.01000000", avg_entry_price: "50000", realized_pnl_quote: "0",
  fees_paid_quote: "0", updated_at: "",
} as Position;

const orderBody = () => vi.mocked(placeOrder).mock.calls.at(-1)![0];
const filled = { data: { ok: true, order: { id: "o1" }, fills: [{ qty: "0.002", price: "50000" }] } } as never;

function mount(position: Position | null = null) {
  return render(
    <ToastProvider>
      <UnifiedOrderPanel pair={PAIR} position={position} onOrderFilled={() => {}} />
    </ToastProvider>,
  );
}
const amount = () => screen.getAllByPlaceholderText("0.00").at(-1) as HTMLInputElement;
async function typeAmount(v = "100") {
  fireEvent.change(amount(), { target: { value: v } });
  await waitFor(() => expect(screen.getByRole("button", { name: /^OPEN LONG/ })).toBeEnabled());
}
const submit = () => userEvent.click(screen.getByRole("button", { name: /^OPEN LONG/ }));
const available = () => screen.getByText("AVAILABLE").parentElement!.textContent;

beforeEach(() => {
  vi.mocked(placeOrder).mockReset().mockResolvedValue(filled);
  vi.mocked(createTrigger).mockReset().mockResolvedValue({ data: {} } as never);
  vi.mocked(createOco).mockReset().mockResolvedValue({ data: {} } as never);
  lev.getLeverageInfo.mockReset().mockResolvedValue({ data: { ok: true, pairId: "p-btc", marginMode: "SPOT", cap: 1 } });
  getMatchWallets.mockReset().mockResolvedValue({
    data: { ok: true, wallets: [wallet("m-usd", "a-usd", "50000"), wallet("m-btc", "a-btc", "0")] },
  });
  useAppStore.setState({
    pairs: [PAIR], initialized: true, sseConnectionState: "connected", matchWallets: null,
    wallets: [wallet("f-usd", "a-usd", "100000"), wallet("f-btc", "a-btc", "0")],
  });
  useActiveMatchStore.getState().setActiveMatch(null);
  useTradingStore.setState({
    selectedPairId: "p-btc", orderType: "MARKET", orderSide: "BUY", qty: "", limitPrice: "", activeTriggers: [],
    snapshot: { bid: "50000", ask: "50000", last: "50000", ts: "0", source: "live" },
  });
});

describe("what an order sends", () => {
  it("no match: scope free", async () => {
    mount();
    await typeAmount();
    await submit();
    expect(orderBody()).toMatchObject({ scope: "free" });
  });

  it("MATCH: the match's id", async () => {
    useActiveMatchStore.getState().setActiveMatch(MATCH);
    mount();
    await typeAmount();
    await submit();
    expect(orderBody()).toMatchObject({ scope: "m1" });
  });

  it("PRACTICE during a match: scope free", async () => {
    useActiveMatchStore.getState().setActiveMatch(MATCH);
    useActiveMatchStore.getState().setTradeMode("PRACTICE");
    mount();
    await typeAmount();
    await submit();
    expect(orderBody()).toMatchObject({ scope: "free" });
  });

  it("the TP sent with an order names the order's scope", async () => {
    useActiveMatchStore.getState().setActiveMatch(MATCH);
    mount();
    await typeAmount();
    fireEvent.change(screen.getByPlaceholderText("above entry"), { target: { value: "60000" } });
    await submit();
    await waitFor(() => expect(createTrigger).toHaveBeenCalled());
    expect(vi.mocked(createTrigger).mock.calls[0]![0]).toMatchObject({ scope: "m1" });
  });

  it("TP + SL: the OCO names it too", async () => {
    useActiveMatchStore.getState().setActiveMatch(MATCH);
    useActiveMatchStore.getState().setTradeMode("PRACTICE");
    mount();
    await typeAmount();
    fireEvent.change(screen.getByPlaceholderText("above entry"), { target: { value: "60000" } });
    fireEvent.change(screen.getByPlaceholderText("below entry"), { target: { value: "40000" } });
    await submit();
    await waitFor(() => expect(createOco).toHaveBeenCalled());
    expect(vi.mocked(createOco).mock.calls[0]![0]).toMatchObject({ scope: "free" });
  });

  it("CLOSE POSITION names the scope on screen", async () => {
    useActiveMatchStore.getState().setActiveMatch(MATCH);
    mount(POSITION);
    await userEvent.click(screen.getByRole("button", { name: "CLOSE POSITION" }));
    expect(orderBody()).toMatchObject({ scope: "m1", reduceOnly: true });
  });

  it("the switch flipped while an order is in flight: its TP stays with the order", async () => {
    useActiveMatchStore.getState().setActiveMatch(MATCH);
    let answer!: (v: unknown) => void;
    vi.mocked(placeOrder).mockReturnValue(new Promise((r) => { answer = r; }) as never);
    mount();
    await typeAmount();
    fireEvent.change(screen.getByPlaceholderText("above entry"), { target: { value: "60000" } });
    await submit();
    act(() => useActiveMatchStore.getState().setTradeMode("PRACTICE"));
    await act(async () => { answer(filled); });
    await waitFor(() => expect(createTrigger).toHaveBeenCalled());
    expect(orderBody()).toMatchObject({ scope: "m1" });
    expect(vi.mocked(createTrigger).mock.calls[0]![0]).toMatchObject({ scope: "m1" });
  });
});

describe("what the panel shows", () => {
  it("AVAILABLE follows the switch, both ways", async () => {
    useActiveMatchStore.getState().setActiveMatch(MATCH);
    mount();
    await waitFor(() => expect(available()).toContain("50,000"));
    act(() => useActiveMatchStore.getState().setTradeMode("PRACTICE"));
    await waitFor(() => expect(available()).toContain("100,000"));
    act(() => useActiveMatchStore.getState().setTradeMode("MATCH"));
    await waitFor(() => expect(available()).toContain("50,000"));
  });

  it("the leverage info is the scope's", async () => {
    useActiveMatchStore.getState().setActiveMatch(MATCH);
    mount();
    await waitFor(() => expect(lev.getLeverageInfo).toHaveBeenLastCalledWith("p-btc", "m1"));
    act(() => useActiveMatchStore.getState().setTradeMode("PRACTICE"));
    await waitFor(() => expect(lev.getLeverageInfo).toHaveBeenLastCalledWith("p-btc", "free"));
  });
});

describe("switching mid-session", () => {
  it("an amount typed for one scope doesn't carry over to the other", async () => {
    useActiveMatchStore.getState().setActiveMatch(MATCH);
    mount();
    await typeAmount("5000");
    act(() => useActiveMatchStore.getState().setTradeMode("PRACTICE"));
    expect(amount().value).toBe("");
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("the next order after a switch goes to the new scope", async () => {
    useActiveMatchStore.getState().setActiveMatch(MATCH);
    mount();
    await typeAmount();
    await submit();
    act(() => useActiveMatchStore.getState().setTradeMode("PRACTICE"));
    await waitFor(() => expect(screen.queryByText("ORDER PLACED")).toBeNull(), { timeout: 3000 });
    await typeAmount();
    await submit();
    expect(vi.mocked(placeOrder).mock.calls.map(([b]) => (b as { scope: string }).scope)).toEqual(["m1", "free"]);
  });
});

describe("a match starting or ending while on /trade", () => {
  it("starting: the form clears, and the next order is the match's", async () => {
    mount();
    await typeAmount("5000");
    act(() => useActiveMatchStore.getState().setActiveMatch(MATCH));
    expect(amount().value).toBe("");
    await typeAmount();
    await submit();
    expect(orderBody()).toMatchObject({ scope: "m1" });
  });

  it("a new match starts in MATCH, even after practicing in the last one", () => {
    useActiveMatchStore.getState().setActiveMatch(MATCH);
    useActiveMatchStore.getState().setTradeMode("PRACTICE");
    useActiveMatchStore.getState().setActiveMatch({ ...MATCH, id: "m2" });
    expect(useActiveMatchStore.getState().tradeMode).toBe("MATCH");
  });

  it("ending: the form clears, and the next order is free-play", async () => {
    useActiveMatchStore.getState().setActiveMatch(MATCH);
    mount();
    await typeAmount("5000");
    act(() => useActiveMatchStore.getState().setActiveMatch(null));
    expect(amount().value).toBe("");
    await typeAmount();
    await submit();
    expect(orderBody()).toMatchObject({ scope: "free" });
  });

  it("the match ended under the click: match_ended is said, and nothing is resent", async () => {
    useActiveMatchStore.getState().setActiveMatch(MATCH);
    vi.mocked(placeOrder).mockRejectedValue({ response: { status: 409, data: { error: "match_ended" } } });
    mount();
    await typeAmount();
    await submit();
    expect((await screen.findByTestId("order-error")).textContent).toBe("Match ended");
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });
});

describe("an out-of-date client", () => {
  it("scope_required: the words and a refresh button", async () => {
    vi.mocked(placeOrder).mockRejectedValue({
      response: { status: 400, data: { error: "scope_required", message: "TRADR was updated — refresh to continue" } },
    });
    mount();
    await typeAmount();
    await submit();
    expect((await screen.findByTestId("order-error")).textContent).toContain("TRADR was updated — refresh to continue");
    expect(screen.getByRole("button", { name: "REFRESH" })).toBeTruthy();
  });

  it("any other rejection has no refresh button", async () => {
    vi.mocked(placeOrder).mockRejectedValue({ response: { status: 400, data: { error: "insufficient_balance" } } });
    mount();
    await typeAmount();
    await submit();
    await screen.findByTestId("order-error");
    expect(screen.queryByRole("button", { name: "REFRESH" })).toBeNull();
  });
});
