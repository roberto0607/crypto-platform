/**
 * The order panel with real leverage (leverage PR 6b). The server decides
 * (GET /leverage, mocked here): the selector appears only for ISOLATED with a
 * cap above 1x, offers only values up to the cap, locks to an open
 * position's leverage, and `leverage` is sent with the order. The amount
 * becomes MARGIN; notional, fee and est. liq price are previewed with
 * lib/margin.ts; AVAILABLE is free USD; EQUITY counts margin + capped uPnL.
 * The ISOLATED position card shows leverage, margin, liq price, mark, health,
 * capped P&L and return on margin. CLOSE is reduce-only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const flags = vi.hoisted(() => ({ SHOW_LEVERAGE_SELECTOR: true }));
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
import type { Position, TradingPair } from "@/types/api";

const PRICE = "83000";
const PAIR: TradingPair = {
  id: "p1", symbol: "BTC/USD", base_asset_id: "a-btc", quote_asset_id: "a-usd", is_active: true,
  fee_bps: 0, maker_fee_bps: 2, taker_fee_bps: 5, trading_enabled: true, created_at: "2026-10-15T00:00:00Z",
};

const info = (over: Record<string, unknown> = {}) => ({
  ok: true, pairId: "p1", enabled: true, marginMode: "ISOLATED", cap: 10, mmrBps: 50,
  positionLeverage: null, blockedBy: null, scope: { competitionId: null, matchId: null }, ...over,
});

// $50 at 10x long from 83,000 (the design's worked example), as GET /positions returns it.
const ISO_LONG: Position = {
  user_id: "u1", pair_id: "p1", base_qty: "0.00602409", avg_entry_price: "83000.00000000",
  realized_pnl_quote: "0", fees_paid_quote: "0.24999973", unrealized_pnl_quote: "0", current_price: PRICE,
  updated_at: "2026-10-26T00:00:00Z", margin_mode: "ISOLATED", leverage: "10.00",
  isolated_margin: "49.99994700", liq_price: "75075.37688442", mark_price: PRICE, margin_health: "1.0000",
};

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function setPrice(p: string) {
  act(() => { useTradingStore.setState({ snapshot: { bid: p, ask: p, last: p, ts: "0", source: "live" } }); });
}

async function mount(position: Position | null = null, onOrderFilled = () => {}) {
  render(
    <ToastProvider>
      <UnifiedOrderPanel pair={PAIR} position={position} positions={position ? [position] : []} onOrderFilled={onOrderFilled} />
    </ToastProvider>,
  );
  await settle();
}

/** The open-position card (scoped queries: MARGIN / 10x also appear in the form). */
const card = () => within(screen.getByTestId("position-leverage").closest(".tr-position-card-sticky") as HTMLElement);

const radios = () => screen.queryAllByRole("radio").map((r) => r.textContent);
/** A row of the order summary (scoped: the ISOLATED card has its own EQUITY / NOTIONAL). */
const sumVal = (label: string) => within(document.querySelector(".tr-summary") as HTMLElement).getByText(label).parentElement!.querySelector("span:last-child")!.textContent;

beforeEach(() => {
  vi.mocked(placeOrder).mockReset().mockResolvedValue({ data: { ok: true, order: { id: "o1" }, fills: [] } } as never);
  flags.SHOW_LEVERAGE_SELECTOR = true;
  lev.info = info();
  useAppStore.setState({
    initialized: true, sseConnectionState: "connected", matchWallets: null,
    wallets: [
      { id: "w-usd", user_id: "u1", asset_id: "a-usd", balance: "1000.00000000", reserved: "0.00000000", created_at: "", updated_at: "" },
      // A leftover base balance (e.g. conversion residue) must not shrink an ISOLATED user's AVAILABLE.
      { id: "w-btc", user_id: "u1", asset_id: "a-btc", balance: "-0.01000000", reserved: "0.00000000", created_at: "", updated_at: "" },
    ],
  });
  useTradingStore.setState({
    selectedPairId: "p1", orderType: "MARKET", orderSide: "BUY", qty: "", limitPrice: "", activeTriggers: [],
    snapshot: { bid: PRICE, ask: PRICE, last: PRICE, ts: "0", source: "live" },
  });
});

describe("the selector", () => {
  it("cap 10: 1x 2x 3x 5x 10x; cap 5: no 10x; cap 3: up to 3x", async () => {
    await mount();
    expect(radios()).toEqual(["1x", "2x", "3x", "5x", "10x"]);
  });

  it.each([[5, ["1x", "2x", "3x", "5x"]], [3, ["1x", "2x", "3x"]]] as const)("cap %d", async (cap, expected) => {
    lev.info = info({ cap });
    await mount();
    expect(radios()).toEqual(expected);
  });

  it("hidden for SPOT, for a 1x cap, while GET /leverage fails, and with the kill switch off", async () => {
    for (const setup of [
      () => { lev.info = info({ marginMode: "SPOT", cap: 1 }); },
      () => { lev.info = info({ cap: 1 }); },
      () => { lev.info = null; },
      () => { flags.SHOW_LEVERAGE_SELECTOR = false; },
    ]) {
      setup();
      const { unmount } = render(
        <ToastProvider><UnifiedOrderPanel pair={PAIR} position={null} onOrderFilled={() => {}} /></ToastProvider>,
      );
      await settle();
      expect(radios()).toEqual([]);
      expect(screen.queryByText("MARGIN")).toBeNull();
      unmount();
      flags.SHOW_LEVERAGE_SELECTOR = true;
    }
  });

  it("an open position locks it to the position's leverage", async () => {
    lev.info = info({ positionLeverage: "5.00" });
    await mount(ISO_LONG);
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "10x" }));
    const checked = screen.getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked.map((r) => r.textContent)).toEqual(["5x"]);
    expect(screen.getByText("Close the position to change leverage")).toBeTruthy();
  });

  it("a resting SPOT order on the pair: says why leverage is refused", async () => {
    lev.info = info({ blockedBy: "spot_orders_open" });
    await mount();
    expect(screen.getByText(/Cancel your open orders on this pair/)).toBeTruthy();
  });
});

describe("the order: input = margin", () => {
  it("$50 at 10x: notional $500, fee on the notional, liq $75,075.38 (−9.5%); sends leverage 10", async () => {
    await mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "10x" }));
    expect(screen.getByText("MARGIN")).toBeTruthy();
    await user.type(screen.getByPlaceholderText("0.00"), "50");

    expect(sumVal("NOTIONAL")).toBe("$500.00");
    expect(sumVal("EST. LIQ PRICE")).toBe("$75,075.38");
    expect(screen.getByText("$75,075.38").getAttribute("title")).toContain("(-9.5% from entry)");
    expect(screen.getByText(/FEE \(5 bps\)/).parentElement!.textContent).toContain("$0.2500");

    await user.click(screen.getByRole("button", { name: /OPEN LONG/ }));
    expect(placeOrder).toHaveBeenCalledTimes(1);
    const body = vi.mocked(placeOrder).mock.calls[0]![0];
    expect(body).toEqual({ pairId: "p1", side: "BUY", type: "MARKET", qty: "0.00602409", leverage: 10 });
  });

  it("a short at 10x: liq $90,845.77 (+9.5%)", async () => {
    await mount();
    const user = userEvent.setup();
    await user.click(screen.getByText("SHORT"));
    await user.click(screen.getByRole("radio", { name: "10x" }));
    await user.type(screen.getByPlaceholderText("0.00"), "50");
    expect(sumVal("EST. LIQ PRICE")).toBe("$90,845.77");
    expect(screen.getByText("$90,845.77").getAttribute("title")).toContain("(+9.5% from entry)");
  });

  it("1x long: NONE (can't be liquidated); still sends leverage 1 (the user chose it)", async () => {
    await mount();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("0.00"), "50");
    expect(sumVal("EST. LIQ PRICE")).toBe("NONE");
    await user.click(screen.getByRole("button", { name: /OPEN LONG/ }));
    expect(vi.mocked(placeOrder).mock.calls[0]![0]).toMatchObject({ leverage: 1 });
  });

  it("AVAILABLE is free USD (no 2× rule, base residue ignored); MAX leaves room for the fee", async () => {
    await mount();
    expect(sumVal("AVAILABLE")).toBe("$1,000.00 USD");
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "10x" }));
    await user.click(screen.getByText("MAX"));
    expect((screen.getByPlaceholderText("0.00") as HTMLInputElement).value).toBe("995.02");
  });

  it("EQUITY = USD + margin + capped uPnL", async () => {
    lev.info = info({ positionLeverage: "10.00" });
    await mount(ISO_LONG);
    expect(sumVal("EQUITY")).toBe("$1,050.00 USD"); // 1000 + 49.999947 + 0 at entry
    setPrice("80000");
    expect(sumVal("EQUITY")).toBe("$1,031.93 USD"); // uPnL −18.07
    setPrice("60000");
    expect(sumVal("EQUITY")).toBe("$1,000.00 USD"); // loss capped at the margin
  });
});

describe("the ISOLATED position card", () => {
  beforeEach(() => { lev.info = info({ positionLeverage: "10.00" }); });

  it("leverage, mark, margin, liq price, health 100% at entry", async () => {
    await mount(ISO_LONG);
    expect(screen.getByTestId("position-leverage").textContent).toBe("10x");
    expect(card().getByText("MARGIN").nextElementSibling!.textContent).toBe("$50.00");
    const liq = card().getByText("LIQ PRICE").nextElementSibling!;
    expect(liq.textContent).toBe("$75,075.38");
    expect(liq.getAttribute("title")).toBe("Liquidation at $75,075.38 (-9.5% from entry)");
    expect(card().getByText("MARK")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Margin health" }).getAttribute("aria-valuenow")).toBe("100");
  });

  it("at $80,000: P&L −$18.07 (−36.14% of margin), health 62%; $78,000 amber; past bankruptcy: −$50.00 (−100%), red", async () => {
    await mount(ISO_LONG);
    setPrice("80000");
    const pnl = () => card().getByText("P&L").nextElementSibling!.textContent;
    const roe = () => card().getByText("ROE").nextElementSibling!.textContent;
    expect(pnl()).toBe("$-18.07");
    expect(roe()).toBe("-36.14%");
    // Health is linear from entry (100%) to liq (0%): (80,000 − 75,075.38) / 7,924.62 = 62%.
    const meterNow = () => Number(screen.getByRole("meter", { name: "Margin health" }).getAttribute("aria-valuenow"));
    expect(meterNow()).toBe(62);
    setPrice("78000"); // 37%: amber
    expect(meterNow()).toBe(37);
    expect(screen.getByText("37%").style.color).toBe("rgb(245, 158, 11)");
    setPrice("70000");
    expect(pnl()).toBe("$-50.00");
    expect(roe()).toBe("-100.00%");
    const meter = screen.getByRole("meter", { name: "Margin health" });
    expect(meter.getAttribute("aria-valuenow")).toBe("0");
    expect(meter.className).toBe("margin-health-danger");
  });

  it("a SPOT position keeps the old card (no badge, VALUE, no health)", async () => {
    const { margin_mode: _m, leverage: _l, isolated_margin: _i, liq_price: _q, mark_price: _k, margin_health: _h, ...spot } = ISO_LONG;
    lev.info = info({ marginMode: "SPOT", cap: 1 });
    await mount(spot as Position);
    expect(screen.queryByTestId("position-leverage")).toBeNull();
    expect(screen.getByText("VALUE")).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
  });
});

describe("CLOSE POSITION", () => {
  it("is reduce-only", async () => {
    lev.info = info({ positionLeverage: "10.00" });
    await mount(ISO_LONG);
    await userEvent.setup().click(screen.getByRole("button", { name: /CLOSE POSITION/ }));
    expect(vi.mocked(placeOrder).mock.calls[0]![0]).toEqual({
      pairId: "p1", side: "SELL", type: "MARKET", qty: "0.00602409", reduceOnly: true,
    });
  });

  it("lost the race (liquidated first): 'Position already closed', the card refreshes, no error state", async () => {
    vi.mocked(placeOrder).mockRejectedValueOnce({ response: { status: 400, data: { ok: false, error: "reduce_only_no_position" } } });
    const refreshed = vi.fn();
    lev.info = info({ positionLeverage: "10.00" });
    await mount(ISO_LONG, refreshed);
    await userEvent.setup().click(screen.getByRole("button", { name: /CLOSE POSITION/ }));
    await settle();
    expect(refreshed).toHaveBeenCalled();
    expect(screen.getByText("Position already closed.")).toBeTruthy();
    expect(within(document.body).queryByText("Close failed")).toBeNull();
  });
});
