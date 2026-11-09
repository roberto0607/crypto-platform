/**
 * CLOSE & REVERSE says what it does. With a $1,000 LONG open, a $4,000 SHORT
 * closes the long and opens a $3,000 SHORT: the preview and the confirm say
 * so in dollars, the fee line is the whole fill's fee (both legs), and the
 * TP/SL estimates and est. liq are the RESULTING $3,000 short's, not the
 * $4,000 order's. The order itself is unchanged: one $4,000 SELL.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const flags = vi.hoisted(() => ({ SHOW_LEVERAGE_SELECTOR: false, SHOW_FUNDING_IN_CHART_HEADER: false }));
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
  createTrigger: vi.fn().mockResolvedValue({ data: { ok: true } }),
  createOco: vi.fn(),
}));
// The book at 80,000 flat: the quote is the order's own size, price and fee.
vi.mock("@/api/endpoints/quote", () => ({
  getMarketQuote: vi.fn(async (p: { qty?: string }) => {
    const qty = Number(p.qty ?? 0);
    const notional = qty * 80_000;
    return {
      data: {
        executable: true, reason: null, qty: p.qty, touchPrice: "80000", estimatedPrice: "80000",
        slippage_bps: "0", slippageQuote: "0", requestedNotional: notional.toFixed(8),
        feeQuote: (notional * 5 / 10_000).toFixed(8), maxOrderNotional: "5000000",
      },
    };
  }),
}));

import { UnifiedOrderPanel } from "@/components/trading/UnifiedOrderPanel";
import ToastProvider from "@/components/ToastProvider";
import { placeOrder } from "@/api/endpoints/trading";
import { useTradingStore } from "@/stores/tradingStore";
import { useAppStore } from "@/stores/appStore";
import type { Position, TradingPair } from "@/types/api";

const PAIR: TradingPair = {
  id: "p1", symbol: "BTC/USD", base_asset_id: "a-btc", quote_asset_id: "a-usd", is_active: true,
  fee_bps: 0, maker_fee_bps: 2, taker_fee_bps: 5, trading_enabled: true, created_at: "2026-10-15T00:00:00Z",
};

// 0.0125 BTC long from 79,000: $1,000 at the 80,000 mark, +$12.50.
const LONG: Position = {
  user_id: "u1", pair_id: "p1", base_qty: "0.01250000", avg_entry_price: "79000.00000000",
  realized_pnl_quote: "0", fees_paid_quote: "0.49375000", unrealized_pnl_quote: "12.5", current_price: "80000",
  updated_at: "2026-10-26T00:00:00Z",
};

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function shortFor(usd: string) {
  render(
    <ToastProvider>
      <UnifiedOrderPanel pair={PAIR} position={LONG} positions={[LONG]} onOrderFilled={() => {}} />
    </ToastProvider>,
  );
  await settle();
  const user = userEvent.setup();
  await user.click(screen.getByText("SHORT"));
  await user.type(screen.getByPlaceholderText("0.00"), usd);
  await settle();
  return user;
}

const row = (label: RegExp) => {
  const lbl = screen.getAllByText(label).find((el) => el.classList.contains("tr-sum-lbl"));
  return lbl!.parentElement!.querySelector(".tr-sum-val")!.textContent;
};

beforeEach(() => {
  vi.mocked(placeOrder).mockClear();
  lev.info = null;
  useAppStore.setState({
    initialized: true, sseConnectionState: "connected", matchWallets: null,
    wallets: [
      { id: "w-usd", user_id: "u1", asset_id: "a-usd", balance: "10000.00000000", reserved: "0.00000000", created_at: "", updated_at: "" },
      { id: "w-btc", user_id: "u1", asset_id: "a-btc", balance: "0.01250000", reserved: "0.00000000", created_at: "", updated_at: "" },
    ],
  });
  useTradingStore.setState({
    selectedPairId: "p1", orderType: "MARKET", orderSide: "BUY", qty: "", limitPrice: "", activeTriggers: [],
    snapshot: { bid: "80000", ask: "80000", last: "80000", ts: "0", source: "live" },
  });
});

describe("CLOSE & REVERSE: $1,000 LONG open, $4,000 SHORT entered", () => {
  it("the preview says what it closes and what it opens, in dollars", async () => {
    await shortFor("4000");
    expect(screen.getByRole("button", { name: "CLOSE & REVERSE" })).toBeTruthy();
    expect(screen.getByTestId("flip-summary").textContent).toBe(
      "Closes your $1,000.00 LONG (+$12.50) and opens a $3,000.00 SHORT");
    // The position you end up with, not the order.
    expect(row(/^NEW POSITION$/)).toBe("$3,000.00");
  });

  it("the fee line is the whole fill's fee: both legs", async () => {
    await shortFor("4000");
    expect(row(/BOTH LEGS/)).toBe("$2.00");
  });

  it("TP/SL estimates are the $3,000 short's", async () => {
    const user = await shortFor("4000");
    await user.type(screen.getByPlaceholderText("above entry"), "81000");  // SL
    await user.type(screen.getByPlaceholderText("below entry"), "79000");  // TP
    // 0.0375 BTC × 1,000, not the order's 0.05 × 1,000 = $50.
    expect(screen.getByText(/^Est\. loss:/).textContent).toContain("-$37.50");
    expect(screen.getByText(/^Est\. profit:/).textContent).toContain("+$37.50");
  });

  it("the confirm says the same; the order is unchanged (one $4,000 SELL)", async () => {
    const user = await shortFor("4000");
    await user.click(screen.getByRole("button", { name: "CLOSE & REVERSE" }));
    expect(placeOrder).not.toHaveBeenCalled();
    expect(screen.getByTestId("confirm-box").textContent).toContain(
      "Closes your $1,000.00 LONG (+$12.50) and opens a $3,000.00 SHORT. Confirm?");
    await user.click(screen.getByRole("button", { name: "CONFIRM" }));
    await settle();
    expect(placeOrder).toHaveBeenCalledTimes(1);
    const body = vi.mocked(placeOrder).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(body).toMatchObject({ side: "SELL", type: "MARKET", qty: "0.05000000" });
    expect(body).not.toHaveProperty("reduceOnly");
  });

  it("a plain order keeps its labels", async () => {
    await shortFor("500");  // a reduce
    expect(screen.queryByTestId("flip-summary")).toBeNull();
    expect(row(/^POSITION SIZE$/)).toBe("$500.00");
    expect(row(/^FEE \(5 bps\)$/)).toBe("$0.2500");
  });
});
