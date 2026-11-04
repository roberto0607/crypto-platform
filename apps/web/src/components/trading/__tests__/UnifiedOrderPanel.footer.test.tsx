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
 *
 * Follow-up (position-card redesign): pinned, that group (~440px) covered the
 * top of a ~600px panel, hiding the MARKET/LIMIT row and the inputs behind
 * the summary. Now the card is the panel's first child (above LONG/SHORT,
 * visible without scrolling) and the summary + submit footer is in normal
 * flow (-order-footer-with-position: position:static).
 *
 * Follow-up (audit F-04): CLOSE sat at the bottom of that card, under the book
 * at 1280×720. It and the confirms are now a small bar (-pos-actions) after
 * the footer, the one thing pinned; see the truth test and the CSS test there.
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

describe.each(["tr", "lmv"] as const)("%s: the card, the form and summary + OPEN don't overlap", (p) => {
  it("with a position open, the card is first in the panel (above LONG/SHORT); summary + OPEN close it, in flow", async () => {
    const c = await mount(p, POS);
    const section = c.querySelector(`.${p}-order-section`)!;
    const kids = [...section.children].map((el) => el.className);
    expect(kids[0]).toBe(`${p}-position-card-sticky`);
    expect(kids[1]).toContain(`${p}-dir-toggle`);
    const footer = c.querySelector(`.${p}-order-footer`)!;
    expect(footer.classList.contains(`${p}-order-footer-with-position`)).toBe(true);
    const fkids = [...footer.children].map((el) => el.className);
    expect(fkids[0]).toBe(`${p}-summary`);
    expect(fkids.some((k) => k.includes(`${p}-place-btn`))).toBe(true);
    expect(footer.querySelector(`.${p}-position-card-sticky`)).toBeNull();
    // Then the pinned actions, and nothing of the order form after it.
    expect(footer.nextElementSibling?.className).toBe(`${p}-pos-actions`);
    expect(footer.nextElementSibling?.nextElementSibling).toBeNull();
  });

  it("without a position: unchanged (no card, no with-position class)", async () => {
    const c = await mount(p, null);
    const footer = c.querySelector(`.${p}-order-footer`)!;
    expect(footer.classList.contains(`${p}-order-footer-with-position`)).toBe(false);
    expect(c.querySelector(`.${p}-position-card-sticky`)).toBeNull();
  });
});
