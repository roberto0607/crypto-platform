/**
 * Request budget for a /trade session (QA 2026-10-11 P1: normal use hit 429).
 *
 * The server allows 200 requests/min per user across all routes. An idle
 * /trade tab used to spend ~125/min on GET /market/book alone: every price
 * tick (many per second) triggered a refetch, throttled to one per 500ms.
 * The book now arrives over SSE (book.snapshot), so a live feed should cost
 * ~0 book requests, with HTTP only as a backup when book events stop.
 *
 * Drives the real useSSE handlers with a realistic feed: 10 price ticks/s,
 * a book.snapshot every 500ms (the server's push cap) and a fill now and then.
 * The 5s backup interval mirrors TradingPage's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { SSEHandlers } from "@/api/sse";

const captured: { handlers: SSEHandlers | null } = { handlers: null };

vi.mock("@/api/sse", () => ({
  connectSSE: (_token: string, handlers: SSEHandlers) => {
    captured.handlers = handlers;
    return () => {};
  },
  disconnectSSE: () => {},
  forceReconnectSSE: () => {},
}));

const book = { bids: [{ price: "100", qty: "1", count: "1" }], asks: [{ price: "101", qty: "1", count: "1" }] };
const getKrakenBook = vi.fn(async () => ({ data: { ok: true, book } }));
const getOrderBook = vi.fn(async () => ({ data: { ok: true, book } }));
vi.mock("@/api/endpoints/trading", async (orig) => ({
  ...(await orig<typeof import("@/api/endpoints/trading")>()),
  getKrakenBook: () => getKrakenBook(),
  getOrderBook: () => getOrderBook(),
}));

import { useSSE } from "@/hooks/useSSE";
import { useAuthStore } from "@/stores/authStore";
import { useAppStore } from "@/stores/appStore";
import { useTradingStore } from "@/stores/tradingStore";

const PAIR = "btc-pair";
const GLOBAL_LIMIT_PER_MIN = 200; // keep in sync with apps/api/src/app.ts

function bookRequests(): number {
  return getKrakenBook.mock.calls.length + getOrderBook.mock.calls.length;
}

/** Run `seconds` of a live /trade session. `bookEvents: false` = book feed down. */
function runSession(seconds: number, opts: { bookEvents: boolean }) {
  const h = captured.handlers!;
  const backup = () => {
    const s = useTradingStore.getState() as unknown as { refreshBookIfStale?: () => void; refreshBook: () => void };
    (s.refreshBookIfStale ?? s.refreshBook)();
  };
  for (let ms = 0; ms < seconds * 1000; ms += 100) {
    h.onPriceTick!({ type: "price.tick", ts: Date.now(), data: { pairId: PAIR, symbol: "BTC/USD", bid: "100", ask: "101", last: "100.5" } } as never);
    if (opts.bookEvents && ms % 500 === 0) {
      h.onBookSnapshot?.({ type: "book.snapshot", ts: Date.now(), data: { pairId: PAIR, bookTs: Date.now(), ...book } } as never);
    }
    if (ms % 15_000 === 0) {
      h.onTradeCreated!({ type: "trade.created", ts: Date.now(), data: { tradeId: `t${ms}`, pairId: PAIR, side: "BUY", price: "100", qty: "1", quoteAmount: "100" } } as never);
    }
    if (ms % 5_000 === 0) backup();
    vi.advanceTimersByTime(100);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  captured.handlers = null;
  getKrakenBook.mockClear();
  getOrderBook.mockClear();
  useAuthStore.setState({ isAuthenticated: true, accessToken: "t" } as never);
  useAppStore.setState({ pairs: [{ id: PAIR, symbol: "BTC/USD" }] as never });
  useTradingStore.setState({ selectedPairId: PAIR, orderBook: null, lastBookEventAt: 0 } as never);
});

afterEach(() => vi.useRealTimers());

describe("/trade request budget", () => {
  it("a live feed costs ~0 book requests per minute (was ~125)", () => {
    renderHook(() => useSSE());
    runSession(60, { bookEvents: true });

    // At most the very first backup check, before any book event landed.
    expect(bookRequests()).toBeLessThanOrEqual(1);
    expect(useTradingStore.getState().orderBook).toEqual(book);
  });

  it("an idle minute stays far below the per-user limit", () => {
    renderHook(() => useSSE());
    runSession(60, { bookEvents: true });

    // Other /trade pollers per minute (measured): /pairs 2 (30s), active
    // match 2 (30s), basis 1 (60s). Book must leave headroom for reloads,
    // trades and extra tabs — keep the idle tab under 10% of the budget.
    const otherPollers = 5;
    expect(bookRequests() + otherPollers).toBeLessThan(GLOBAL_LIMIT_PER_MIN * 0.1);
  });

  it("falls back to HTTP every 5s when book events stop (feed down)", () => {
    renderHook(() => useSSE());
    runSession(60, { bookEvents: false });

    // One backup fetch per 5s interval (+ fills), never per tick.
    expect(bookRequests()).toBeGreaterThanOrEqual(10);
    expect(bookRequests()).toBeLessThanOrEqual(20);
  });
});
