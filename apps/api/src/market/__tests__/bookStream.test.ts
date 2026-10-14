import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { subscribeGlobal, unsubscribe } from "../../events/eventBus";
import type { AppEvent } from "../../events/eventTypes";
import { bookSnapshots } from "../orderFlowFeatures";
import { BOOK_PUSH_INTERVAL_MS, scheduleBookPush, stopBookPush, toWireLevels } from "../bookStream";

const PAIR = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function setBook(pairId: string, bestBid: number, ts: number): void {
  bookSnapshots.set(pairId, {
    bids: [{ price: bestBid, qty: 1 }],
    asks: [{ price: bestBid + 1, qty: 2 }],
    ts,
  });
}

describe("book.snapshot push (replaces tick-driven GET /market/book polling)", () => {
  const sent: AppEvent[] = [];
  const handler = (e: AppEvent) => {
    if (e.type === "book.snapshot") sent.push(e);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    sent.length = 0;
    subscribeGlobal(handler);
  });

  afterEach(() => {
    unsubscribe(handler);
    stopBookPush();
    bookSnapshots.clear();
    vi.useRealTimers();
  });

  it("sends at most one snapshot per pair per interval, and the trailing one is the latest book", () => {
    // 40 book updates in one interval (Kraken can update many times a second).
    for (let i = 0; i < 40; i++) {
      setBook(PAIR, 100 + i, Date.now());
      scheduleBookPush(PAIR);
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(BOOK_PUSH_INTERVAL_MS);

    // 400ms of updates + one interval: leading send + one trailing send.
    expect(sent).toHaveLength(2);
    const last = sent[sent.length - 1]!;
    expect(last.type === "book.snapshot" && last.data.bids[0]!.price).toBe("139");
  });

  it("caps a sustained feed at 1000/BOOK_PUSH_INTERVAL_MS per second per pair", () => {
    for (let ms = 0; ms < 10_000; ms += 20) {
      setBook(PAIR, 100, Date.now());
      scheduleBookPush(PAIR);
      vi.advanceTimersByTime(20);
    }
    const perSecond = sent.length / 10;
    expect(perSecond).toBeLessThanOrEqual(1000 / BOOK_PUSH_INTERVAL_MS + 0.1);
    expect(perSecond).toBeGreaterThanOrEqual(1000 / BOOK_PUSH_INTERVAL_MS - 0.5);
  });

  it("throttles each pair independently and sends the GET /market/book wire shape", () => {
    setBook(PAIR, 100, 5);
    setBook(OTHER, 200, 6);
    scheduleBookPush(PAIR);
    scheduleBookPush(OTHER);
    vi.advanceTimersByTime(0);

    expect(sent.map((e) => (e.data as { pairId: string }).pairId).sort()).toEqual([PAIR, OTHER].sort());
    const a = sent.find((e) => (e.data as { pairId: string }).pairId === PAIR)!;
    expect(a.data).toEqual({
      pairId: PAIR,
      bids: [{ price: "100", qty: "1", count: "1" }],
      asks: [{ price: "101", qty: "2", count: "1" }],
      bookTs: 5,
    });
    expect(a.userId).toBeUndefined(); // broadcast; v1Events filters by interest set
  });

  it("sends nothing once the book is dropped (checksum resync)", () => {
    setBook(PAIR, 100, 1);
    scheduleBookPush(PAIR);
    bookSnapshots.delete(PAIR);
    vi.advanceTimersByTime(BOOK_PUSH_INTERVAL_MS);
    expect(sent).toHaveLength(0);
  });

  it("toWireLevels stringifies price/qty", () => {
    expect(toWireLevels([{ price: 1.5, qty: 0.25 }])).toEqual([{ price: "1.5", qty: "0.25", count: "1" }]);
  });
});
