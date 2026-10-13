/**
 * Trailing-stop offset validation (QA F6, 2026-10-11): the offset is a USD
 * price distance, so it is bounded by the price, not the position's notional.
 * The old check (offset >= position size) blocked any realistic trailing stop
 * on a small position: $500 on a $50 long was rejected.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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

import { UnifiedOrderPanel, trailingOffsetError } from "@/components/trading/UnifiedOrderPanel";
import ToastProvider from "@/components/ToastProvider";
import { useTradingStore } from "@/stores/tradingStore";
import type { TradingPair } from "@/types/api";

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
  created_at: "2026-10-11T00:00:00Z",
};

beforeEach(() => {
  useTradingStore.setState({
    selectedPairId: "p1",
    activeTriggers: [],
    snapshot: { bid: "83950", ask: "83950", last: "83950", ts: "0", source: "live" },
  });
});

async function fillPanel(usd: string, offset: string) {
  render(
    <ToastProvider>
      <UnifiedOrderPanel pair={PAIR} position={null} quoteBalance={100000} onOrderFilled={() => {}} />
    </ToastProvider>,
  );
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText("0.00"), usd);
  await user.type(screen.getByPlaceholderText("offset in USD"), offset);
}

describe("UnifiedOrderPanel trailing stop", () => {
  it("accepts a $500 offset on a $50 long (the QA repro)", async () => {
    await fillPanel("50", "500");
    expect(screen.queryByText(/Trailing stop offset must/)).toBeNull();
    expect(screen.getByText(/Stops at/)).toBeTruthy();
  });

  it("rejects an offset at or above the current price", async () => {
    await fillPanel("50", "83950");
    expect(screen.getByText("Trailing stop offset must be less than the current price")).toBeTruthy();
  });

  it("rejects a zero offset instead of silently skipping the trailing stop", async () => {
    await fillPanel("50", "0");
    expect(screen.getByText("Trailing stop offset must be greater than 0")).toBeTruthy();
  });
});

describe("trailingOffsetError", () => {
  it("bounds the offset by price, not notional", () => {
    expect(trailingOffsetError("", 83950, 0)).toBeNull();
    expect(trailingOffsetError("500", 83950, 0)).toBeNull();
    expect(trailingOffsetError("83949.99", 83950, 0)).toBeNull();
    expect(trailingOffsetError("83950", 83950, 0)).toMatch(/less than the current price/);
    expect(trailingOffsetError("0", 83950, 0)).toMatch(/greater than 0/);
    expect(trailingOffsetError("-5", 83950, 0)).toMatch(/greater than 0/);
    expect(trailingOffsetError("abc", 83950, 0)).toMatch(/greater than 0/);
  });

  it("keeps the offset inside the stop-loss distance", () => {
    expect(trailingOffsetError("500", 83950, 400)).toMatch(/stop loss distance/);
    expect(trailingOffsetError("300", 83950, 400)).toBeNull();
  });
});
