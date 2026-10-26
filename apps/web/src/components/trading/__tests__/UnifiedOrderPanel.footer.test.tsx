/**
 * Bug (QA, 2026-10): with a position open, the FEE / AVAILABLE summary rows
 * and the OPEN button were clipped behind the position card. The card was
 * position:sticky; bottom:0 while the summary flowed underneath it
 * (footer display:contents), so the card covered whatever scrolled under it.
 * Measured in the browser: the card's top at 404px over rows at 392–430px.
 *
 * Fix: with a position open, summary + submit + card are ONE bottom-pinned
 * group (the footer, with the card as its last child), so nothing can be
 * scrolled under the card. jsdom has no layout, so this pins the structure;
 * the overlap itself is checked in the browser (see the PR's screenshots).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";

vi.mock("@/api/endpoints/leverage", () => ({ getLeverageInfo: vi.fn(async () => { throw new Error("n/a"); }) }));
vi.mock("@/api/endpoints/trading", () => ({
  getOrderBook: vi.fn(), getKrakenBook: vi.fn(), getSnapshot: vi.fn(),
  listOrders: vi.fn().mockResolvedValue({ data: { ok: true, orders: [], nextCursor: null } }),
  placeOrder: vi.fn(), cancelOrder: vi.fn(),
}));
vi.mock("@/api/endpoints/triggers", () => ({
  listTriggers: vi.fn().mockResolvedValue({ data: { data: [], nextCursor: null } }),
  cancelTrigger: vi.fn(), updateTrigger: vi.fn(), createTrigger: vi.fn(), createOco: vi.fn(),
}));

import { UnifiedOrderPanel } from "@/components/trading/UnifiedOrderPanel";
import ToastProvider from "@/components/ToastProvider";
import { useTradingStore } from "@/stores/tradingStore";
import { useAppStore } from "@/stores/appStore";
import type { Position, TradingPair } from "@/types/api";

const PAIR = { id: "p1", symbol: "BTC/USD", base_asset_id: "a-btc", quote_asset_id: "a-usd", is_active: true, fee_bps: 0, maker_fee_bps: 2, taker_fee_bps: 5, trading_enabled: true, created_at: "" } as TradingPair;
const POS = { user_id: "u1", pair_id: "p1", base_qty: "0.01", avg_entry_price: "83000", realized_pnl_quote: "0", fees_paid_quote: "0", unrealized_pnl_quote: "0", current_price: "83000", updated_at: "" } as Position;

beforeEach(() => {
  useAppStore.setState({ initialized: true, sseConnectionState: "connected", wallets: [] });
  useTradingStore.setState({ selectedPairId: "p1", orderType: "MARKET", activeTriggers: [], snapshot: { bid: "83000", ask: "83000", last: "83000", ts: "0", source: "live" } });
});

async function mount(prefix: "tr" | "lmv", position: Position | null) {
  const r = render(<ToastProvider><UnifiedOrderPanel pair={PAIR} position={position} onOrderFilled={() => {}} classPrefix={prefix} /></ToastProvider>);
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  return r.container;
}

describe.each(["tr", "lmv"] as const)("%s: summary + OPEN can't sit behind the position card", (p) => {
  it("with a position open, summary, OPEN and the card are one pinned group (card last)", async () => {
    const c = await mount(p, POS);
    const footer = c.querySelector(`.${p}-order-footer`)!;
    expect(footer.classList.contains(`${p}-order-footer-with-position`)).toBe(true);
    const kids = [...footer.children].map((el) => el.className);
    expect(kids[0]).toBe(`${p}-summary`);
    expect(kids.some((k) => k.includes(`${p}-place-btn`))).toBe(true);
    expect(kids.at(-1)).toBe(`${p}-position-card-sticky`);
    // Nothing of the order form after the group.
    expect(footer.nextElementSibling).toBeNull();
  });

  it("without a position: unchanged (no card, no with-position class)", async () => {
    const c = await mount(p, null);
    const footer = c.querySelector(`.${p}-order-footer`)!;
    expect(footer.classList.contains(`${p}-order-footer-with-position`)).toBe(false);
    expect(c.querySelector(`.${p}-position-card-sticky`)).toBeNull();
  });
});
