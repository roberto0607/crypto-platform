import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useTradingStore, BOOK_EVENT_STALE_MS } from "@/stores/tradingStore";

// The order book arrives over SSE (book.snapshot). HTTP is only a backup when
// no event has landed recently (QA 2026-10-11 P1: tick-driven refetching was
// ~125 GET /market/book per minute per /trade tab).

const book = (bid: string) => ({
  bids: [{ price: bid, qty: "1", count: "1" }],
  asks: [{ price: String(Number(bid) + 1), qty: "1", count: "1" }],
});

describe("tradingStore book over SSE", () => {
  const refreshBook = vi.fn(async () => {});

  beforeEach(() => {
    vi.useFakeTimers();
    refreshBook.mockClear();
    useTradingStore.setState({
      selectedPairId: "btc",
      orderBook: null,
      lastBookEventAt: 0,
      lastError: null,
      refreshBook,
    } as never);
  });

  afterEach(() => vi.useRealTimers());

  it("applies a snapshot for the selected pair", () => {
    useTradingStore.getState().applyBookSnapshot("btc", book("100"));
    expect(useTradingStore.getState().orderBook).toEqual(book("100"));
    expect(useTradingStore.getState().lastBookEventAt).toBe(Date.now());
  });

  it("ignores a snapshot for another pair (late event after a pair switch)", () => {
    useTradingStore.getState().applyBookSnapshot("eth", book("5"));
    expect(useTradingStore.getState().orderBook).toBeNull();
    expect(useTradingStore.getState().lastBookEventAt).toBe(0);
  });

  it("clears a stale book error but keeps other errors", () => {
    useTradingStore.setState({ lastError: { source: "book", message: "x", at: 1 } });
    useTradingStore.getState().applyBookSnapshot("btc", book("100"));
    expect(useTradingStore.getState().lastError).toBeNull();

    const snapErr = { source: "snapshot" as const, message: "y", at: 2 };
    useTradingStore.setState({ lastError: snapErr });
    useTradingStore.getState().applyBookSnapshot("btc", book("101"));
    expect(useTradingStore.getState().lastError).toEqual(snapErr);
  });

  it("backup poll fetches only when no book event arrived within BOOK_EVENT_STALE_MS", () => {
    // Never had an event → fetch.
    useTradingStore.getState().refreshBookIfStale();
    expect(refreshBook).toHaveBeenCalledTimes(1);

    // Fresh event → no fetch.
    useTradingStore.getState().applyBookSnapshot("btc", book("100"));
    vi.advanceTimersByTime(BOOK_EVENT_STALE_MS - 1);
    useTradingStore.getState().refreshBookIfStale();
    expect(refreshBook).toHaveBeenCalledTimes(1);

    // Events stopped → fetch again.
    vi.advanceTimersByTime(1);
    useTradingStore.getState().refreshBookIfStale();
    expect(refreshBook).toHaveBeenCalledTimes(2);
  });
});
