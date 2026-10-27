/**
 * One mark everywhere (leverage PR 7): the ISOLATED position card's MARK,
 * P&L, ROE, margin health and the EQUITY row use the liquidation engine's
 * mark (SSE mark.price, the Kraken book mid), not the last-trade ticker.
 * Prod showed card $79,905 while the book mid was ~$79,919.
 *
 *   - engine mark received: shown and used;
 *   - engine paused (stale feed) or silent > 5 s: last good mark, flagged
 *     STALE with "liquidations paused";
 *   - none received (engine off): the ticker, as before;
 *   - health under 25%: a NEAR LIQUIDATION line; position.margin_warning
 *     shows a toast.
 * SPOT positions are untouched.
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
import { useTradingStore } from "@/stores/tradingStore";
import { useAppStore } from "@/stores/appStore";
import { useMarkPriceStore } from "@/stores/markPriceStore";
import { orderPreview } from "@/lib/leverageUi";
import type { Position, TradingPair } from "@/types/api";

const TICKER = "79905";
const PAIR: TradingPair = {
  id: "p1", symbol: "BTC/USD", base_asset_id: "a-btc", quote_asset_id: "a-usd", is_active: true,
  fee_bps: 0, maker_fee_bps: 2, taker_fee_bps: 5, trading_enabled: true, created_at: "2026-10-15T00:00:00Z",
};
const info = { ok: true, pairId: "p1", enabled: true, marginMode: "ISOLATED", cap: 10, mmrBps: 50,
  positionLeverage: "10.00", blockedBy: null, scope: { competitionId: null, matchId: null } };

// $50 at 10x long from 83,000: liq 75,075.38.
const ISO_LONG: Position = {
  user_id: "u1", pair_id: "p1", base_qty: "0.00602409", avg_entry_price: "83000.00000000",
  realized_pnl_quote: "0", fees_paid_quote: "0.24999973", unrealized_pnl_quote: "0", current_price: TICKER,
  updated_at: "2026-10-26T00:00:00Z", margin_mode: "ISOLATED", leverage: "10.00",
  isolated_margin: "49.99994700", liq_price: "75075.37688442", mark_price: TICKER, margin_health: "0.6000",
};

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function mount(position: Position) {
  render(
    <ToastProvider>
      <UnifiedOrderPanel pair={PAIR} position={position} positions={[position]} onOrderFilled={() => {}} />
    </ToastProvider>,
  );
  await settle();
}

const card = () => within(document.querySelector(".tr-position-card-sticky") as HTMLElement);
const markText = () => card().getByText("MARK").nextElementSibling!.textContent;
const health = () => Number(screen.getByRole("meter", { name: "Margin health" }).getAttribute("aria-valuenow"));
/** A row of the order summary (scoped: the ISOLATED card has its own EQUITY / NOTIONAL). */
const sumVal = (label: string) => within(document.querySelector(".tr-summary") as HTMLElement).getByText(label).parentElement!.querySelector("span:last-child")!.textContent;

function engineMark(mark: number | null, paused = false, receivedAt = Date.now()) {
  act(() => {
    useMarkPriceStore.setState((s) => ({
      marks: { ...s.marks, p1: { mark: mark ?? s.marks.p1?.mark ?? null, paused, feed: paused ? "stale" : "ok", receivedAt } },
    }));
  });
}

beforeEach(() => {
  flags.SHOW_LEVERAGE_SELECTOR = true;
  lev.info = info;
  useMarkPriceStore.setState({ marks: {} });
  useAppStore.setState({
    initialized: true, sseConnectionState: "connected", matchWallets: null,
    pairs: [PAIR],
    wallets: [
      { id: "w-usd", user_id: "u1", asset_id: "a-usd", balance: "1000.00000000", reserved: "0.00000000", created_at: "", updated_at: "" },
    ],
  });
  useTradingStore.setState({
    selectedPairId: "p1", orderType: "MARKET", orderSide: "BUY", qty: "", limitPrice: "", activeTriggers: [],
    snapshot: { bid: TICKER, ask: TICKER, last: TICKER, ts: "0", source: "live" },
  });
});

describe("the ISOLATED card uses the engine's mark", () => {
  it("MARK, P&L, ROE, health and EQUITY follow the book mid, not the ticker", async () => {
    await mount(ISO_LONG);
    engineMark(79919);
    expect(markText()).toBe("$79,919.00");
    // 0.00602409 × (79,919 − 83,000) = −18.56; on $50 margin −37.12%.
    expect(card().getByText("P&L").nextElementSibling!.textContent).toBe("$-18.56");
    expect(card().getByText("ROE").nextElementSibling!.textContent).toBe("-37.12%");
    expect(health()).toBe(61); // (79,919 − 75,075.38) / 7,924.62
    expect(sumVal("EQUITY")).toBe("$1,031.44 USD");
    expect(card().queryByText("STALE")).toBeNull();
  });

  it("engine paused: the last good mark, flagged STALE, liquidations paused", async () => {
    await mount(ISO_LONG);
    engineMark(79919);
    engineMark(null, true);
    expect(markText()).toContain("$79,919.00");
    const chip = card().getByText("STALE");
    expect(chip.getAttribute("title")).toMatch(/liquidations are paused/i);
    expect(card().getByText(/FEED STALE · LIQUIDATIONS PAUSED/)).toBeTruthy();
  });

  it("engine silent for more than 5 s: STALE too", async () => {
    await mount(ISO_LONG);
    engineMark(79919, false, Date.now() - 6_000);
    expect(card().getByText("STALE")).toBeTruthy();
  });

  it("no engine mark received (engine off): the ticker, no STALE (as before)", async () => {
    await mount(ISO_LONG);
    expect(markText()).toBe("$79,905.00");
    expect(card().queryByText("STALE")).toBeNull();
  });

  it("another pair's mark doesn't leak in", async () => {
    await mount(ISO_LONG);
    act(() => { useMarkPriceStore.getState().setMark("p2", 3000, false, "ok"); });
    expect(markText()).toBe("$79,905.00");
  });

  it("a SPOT position ignores it: CURRENT is the ticker", async () => {
    const { margin_mode: _m, leverage: _l, isolated_margin: _i, liq_price: _q, mark_price: _k, margin_health: _h, ...spot } = ISO_LONG;
    lev.info = { ...info, marginMode: "SPOT", cap: 1, positionLeverage: null };
    await mount(spot as Position);
    engineMark(79919);
    expect(card().getByText("CURRENT").nextElementSibling!.textContent).toBe("$79,905.00");
    expect(card().queryByText("STALE")).toBeNull();
  });
});

describe("near liquidation", () => {
  it("health under 25%: NEAR LIQUIDATION with the liq price; not at 30%", async () => {
    await mount(ISO_LONG);
    engineMark(77500); // ~31%
    expect(card().queryByText(/NEAR LIQUIDATION/)).toBeNull();
    engineMark(77000); // ~24%
    expect(card().getByText(/NEAR LIQUIDATION/).textContent).toContain("$75,075.38");
  });

  it("position.margin_warning shows a toast", async () => {
    await mount(ISO_LONG);
    act(() => {
      window.dispatchEvent(new CustomEvent("sse:position.margin_warning", { detail: {
        pairId: "p1", symbol: "BTC/USD", competitionId: null, matchId: null, side: "LONG", leverage: "10.00",
        marginHealth: "0.2429", mark: "77000.00000000", liqPrice: "75075.37688442", threshold: 0.25,
      } }));
    });
    expect(screen.getByText("BTC/USD 10x LONG: margin health 24%. Liquidation at $75,075.38.")).toBeTruthy();
  });
});

describe("the card header: EQUITY (what the user has at stake), NOTIONAL as a row", () => {
  it("EQUITY = margin + capped uPnL at the engine mark; NOTIONAL = size × entry", async () => {
    await mount(ISO_LONG);
    engineMark(79919);
    const eq = card().getByText("EQUITY").nextElementSibling!;
    expect(eq.textContent).toBe("$31.44"); // 49.999947 − 18.56
    expect(card().getByText("NOTIONAL").nextElementSibling!.textContent).toBe("$500.00"); // 0.00602409 × 83,000
    engineMark(70000); // past bankruptcy: the loss is capped at the margin
    expect(card().getByText("EQUITY").nextElementSibling!.textContent).toBe("$0.00");
  });

  it("a SPOT card keeps its header (position size, no EQUITY / NOTIONAL labels)", async () => {
    const { margin_mode: _m, leverage: _l, isolated_margin: _i, liq_price: _q, mark_price: _k, margin_health: _h, ...spot } = ISO_LONG;
    lev.info = { ...info, marginMode: "SPOT", cap: 1, positionLeverage: null };
    await mount(spot as Position);
    expect(card().queryByText("EQUITY")).toBeNull();
    expect(card().queryByText("NOTIONAL")).toBeNull();
    expect(card().getByText("$500.00")).toBeTruthy();
  });
});

describe("the order preview uses the engine mark (leveraged MARKET orders)", () => {
  const entry = () => screen.getByText("ENTRY PRICE").parentElement!.querySelector("span:last-child")!;
  const noPosition = async () => {
    lev.info = { ...info, positionLeverage: null };
    render(<ToastProvider><UnifiedOrderPanel pair={PAIR} position={null} positions={[]} onOrderFilled={() => {}} /></ToastProvider>);
    await settle();
  };

  it("ENTRY PRICE and EST. LIQ PRICE from the book mid, not the last trade", async () => {
    await noPosition();
    engineMark(79919);
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "10x" }));
    await user.type(screen.getByPlaceholderText("0.00"), "50");
    expect(entry().textContent).toBe("$79,919.00");
    const want = orderPreview({ margin: 50, leverage: 10, price: 79919, takerBps: 5, mmrBps: 50, side: "LONG" });
    const fmt = (n: number) => "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(sumVal("EST. LIQ PRICE")).toBe(fmt(want.liqPrice!.toNumber()));
    expect(screen.queryByText("STALE")).toBeNull();
  });

  it("engine paused: falls back to the ticker, with the STALE chip", async () => {
    await noPosition();
    engineMark(79919);
    engineMark(null, true);
    expect(entry().textContent).toContain("$79,905.00");
    expect(within(entry() as HTMLElement).getByText("STALE")).toBeTruthy();
  });

  it("a LIMIT order still previews at its limit price", async () => {
    await noPosition();
    engineMark(79919);
    act(() => { useTradingStore.setState({ orderType: "LIMIT", limitPrice: "78000" }); });
    expect(entry().textContent).toBe("$78,000.00");
  });

  it("not leveraged (SPOT): ENTRY PRICE stays the ticker", async () => {
    lev.info = { ...info, marginMode: "SPOT", cap: 1, positionLeverage: null };
    render(<ToastProvider><UnifiedOrderPanel pair={PAIR} position={null} positions={[]} onOrderFilled={() => {}} /></ToastProvider>);
    await settle();
    engineMark(79919);
    expect(entry().textContent).toBe("$79,905.00");
  });
});

