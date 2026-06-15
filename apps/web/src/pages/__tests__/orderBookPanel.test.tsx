import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { OrderBook } from "@/types/api";

// Importing TradingPage pulls in the whole trade-page module graph. Stub the
// heavy children (chart/canvas + sibling panels) so the import stays light and
// jsdom-safe — OrderBookPanel itself depends on none of them.
vi.mock("@/components/trading/CandlestickChart", () => ({ CandlestickChart: () => null }));
vi.mock("@/components/trading/AssetTab", () => ({ default: () => null }));
vi.mock("@/components/trading/UnifiedOrderPanel", () => ({ UnifiedOrderPanel: () => null }));
vi.mock("@/components/trading/OrderDock", () => ({ default: () => null }));

import { prepareBook, OrderBookPanel, spreadRecenterScrollTop } from "@/pages/TradingPage";

/** Build a book. asks ascending (best/lowest first), bids descending (best/highest first). */
function makeBook(
  asks: Array<[price: number, qty: number]>,
  bids: Array<[price: number, qty: number]>,
): OrderBook {
  const lvl = ([price, qty]: [number, number]) => ({
    price: String(price), qty: String(qty), count: "1",
  });
  return { asks: asks.map(lvl), bids: bids.map(lvl) };
}

/** N ask levels ascending from `start`, all the same qty. */
const asks = (n: number, qty: number, start = 100): Array<[number, number]> =>
  Array.from({ length: n }, (_, i) => [start + i, qty]);
/** N bid levels descending from `start`, all the same qty. */
const bids = (n: number, qty: number, start = 99): Array<[number, number]> =>
  Array.from({ length: n }, (_, i) => [start - i, qty]);

describe("prepareBook", () => {
  it("caps each side to maxLevels nearest the spread", () => {
    const book = makeBook(asks(12, 1), bids(12, 1));
    const p = prepareBook(book, 8);
    expect(p.asks).toHaveLength(8);
    expect(p.bids).toHaveLength(8);
  });

  it("defaults to 15 levels/side (#52 density bump)", () => {
    const p = prepareBook(makeBook(asks(20, 1), bids(20, 1)));
    expect(p.asks).toHaveLength(15);
    expect(p.bids).toHaveLength(15);
  });

  it("respects a custom maxLevels", () => {
    const p = prepareBook(makeBook(asks(12, 1), bids(12, 1)), 5);
    expect(p.asks).toHaveLength(5);
    expect(p.bids).toHaveLength(5);
  });

  it("renders asks highest-price-at-top with best ask nearest the spread", () => {
    const p = prepareBook(makeBook(asks(12, 1), bids(12, 1)), 8);
    // asks[0] is the top row (highest visible price), last row is the best ask.
    expect(parseFloat(p.asks[0]!.price)).toBeGreaterThan(parseFloat(p.asks.at(-1)!.price));
    expect(parseFloat(p.asks.at(-1)!.price)).toBe(100); // best (lowest) ask kept
    expect(parseFloat(p.asks[0]!.price)).toBe(107); // 8th-lowest, not the clipped far levels
    // bids keep best (highest) first.
    expect(parseFloat(p.bids[0]!.price)).toBe(99);
    expect(parseFloat(p.bids[0]!.price)).toBeGreaterThan(parseFloat(p.bids.at(-1)!.price));
  });

  it("computes bidPct/askPct over the FULL book (not the cap) and they sum to ~100", () => {
    // 8 near bids @1 (=8) + 2 far bids @50 (=100) → total bid 108; 8 asks @1 → 8.
    // Full-book imbalance = 108 / 116. A cap-only computation would give 50.
    const book = makeBook(asks(8, 1), [...bids(8, 1), [80, 50], [79, 50]]);
    const p = prepareBook(book, 8);
    expect(p.bidPct).toBeCloseTo((108 / 116) * 100, 4);
    expect(p.askPct).toBeCloseTo((8 / 116) * 100, 4);
    expect(p.bidPct + p.askPct).toBeCloseTo(100, 6);
  });

  it("sets maxVisibleQty to the capped-set max, ignoring clipped far levels", () => {
    // Within the visible 8 asks the max qty is 5; two clipped far asks are huge.
    const visible: Array<[number, number]> = [
      [100, 1], [101, 2], [102, 3], [103, 4], [104, 5], [105, 3], [106, 2], [107, 1],
    ];
    const book = makeBook([...visible, [108, 1000], [109, 1000]], bids(8, 1));
    const p = prepareBook(book, 8);
    expect(p.maxVisibleQty).toBe(5);
  });

  it("handles an empty book without throwing", () => {
    const p = prepareBook({ asks: [], bids: [] });
    expect(p.asks).toEqual([]);
    expect(p.bids).toEqual([]);
    expect(p.bidPct).toBe(0);
    expect(p.askPct).toBe(0);
    expect(p.maxVisibleQty).toBe(0);
  });

  it("treats null and one-sided books as empty", () => {
    expect(prepareBook(null).asks).toEqual([]);
    const oneSided = prepareBook(makeBook(asks(3, 1), []));
    expect(oneSided.asks).toEqual([]);
    expect(oneSided.bidPct).toBe(0);
  });

  it("renders a tight spread as a nonzero spreadPct (no '0.000' underflow)", () => {
    // $0.10 spread on a ~$63k book = 0.00016% → must not round to a broken zero.
    const book = makeBook([[63000.1, 1]], [[63000, 1]]);
    const p = prepareBook(book);
    expect(p.spread).toBe("0.10");
    expect(parseFloat(p.spreadPct)).toBeGreaterThan(0);
    expect(p.spreadPct).not.toBe("0.000");
    expect(p.spreadPct).not.toBe("0.0000");
  });

  it("keeps spreadPct a genuine zero when there is no book", () => {
    expect(prepareBook({ asks: [], bids: [] }).spreadPct).toBe("0.0000");
  });
});

describe("OrderBookPanel", () => {
  it("renders exactly maxLevels ask + bid rows and one spread divider", () => {
    // Default cap is 15/side (#52); feed a deeper book so the cap is what bounds it.
    const book = makeBook(asks(20, 1), bids(20, 1));
    const { container } = render(<OrderBookPanel liveBook={book} />);
    expect(container.querySelectorAll(".tr-ob-row.ask")).toHaveLength(15);
    expect(container.querySelectorAll(".tr-ob-row.bid")).toHaveLength(15);
    expect(container.querySelectorAll(".tr-ob-spread")).toHaveLength(1);
  });

  it("sizes the split-bar segments to bidPct/askPct", () => {
    // Asymmetric: 8 bids @1 (=8) vs 8 asks @3 (=24) → 25% / 75%.
    const book = makeBook(asks(8, 3), bids(8, 1));
    const p = prepareBook(book);
    const { container } = render(<OrderBookPanel liveBook={book} />);
    const segs = container.querySelectorAll<HTMLElement>(".tr-ob-splitbar .seg");
    expect(segs).toHaveLength(2);
    expect(segs[0]!.style.width).toBe(`${p.bidPct}%`);
    expect(segs[1]!.style.width).toBe(`${p.askPct}%`);
  });

  it("colors the depth %/segments with the --ob-* palette, not the ladder --g/--red", () => {
    const book = makeBook(asks(8, 1), bids(8, 1));
    const { container } = render(<OrderBookPanel liveBook={book} />);
    const bidNum = container.querySelector<HTMLElement>(".tr-ob-bidpct")!;
    const askNum = container.querySelector<HTMLElement>(".tr-ob-askpct")!;
    expect(bidNum.style.color).toContain("--ob-bid");
    expect(askNum.style.color).toContain("--ob-ask");
    expect(bidNum.style.color).not.toContain("--g");
    expect(askNum.style.color).not.toContain("--red");
    const segs = container.querySelectorAll<HTMLElement>(".tr-ob-splitbar .seg");
    expect(segs[0]!.style.background).toContain("--ob-bid");
    expect(segs[1]!.style.background).toContain("--ob-ask");
  });

  it("stacks the depth readout into two labelled rows (no crammed inline caption)", () => {
    const book = makeBook(asks(8, 1), bids(8, 1));
    const { container } = render(<OrderBookPanel liveBook={book} />);
    const rows = container.querySelectorAll(".tr-ob-depth-row");
    expect(rows).toHaveLength(2);
    const sides = [...container.querySelectorAll(".tr-ob-depth-side")].map((e) => e.textContent);
    expect(sides).toEqual(["BID", "ASK"]);
    // the old single inline "BID / ASK" caption is gone
    const caps = [...container.querySelectorAll(".tr-ob-depth-cap")].map((e) => e.textContent);
    expect(caps).not.toContain("BID / ASK");
  });
});

describe("spreadRecenterScrollTop", () => {
  // container 259, header 27, spread 28 → targetOffset = 27 + (259-27-28)/2 = 129
  const base = { containerClientHeight: 259, headerHeight: 27, spreadHeight: 28 };

  it("returns null when the spread is already within threshold of center", () => {
    expect(spreadRecenterScrollTop({ ...base, currentScrollTop: 100, spreadTopWithinViewport: 129 })).toBeNull();
    // within default 4px threshold either side
    expect(spreadRecenterScrollTop({ ...base, currentScrollTop: 100, spreadTopWithinViewport: 132 })).toBeNull();
    expect(spreadRecenterScrollTop({ ...base, currentScrollTop: 100, spreadTopWithinViewport: 126 })).toBeNull();
  });

  it("scrolls DOWN (increases scrollTop) when the spread sits below center (drifted to bottom)", () => {
    // spread 101px below target → must scroll down by 101 to pull it up to center
    const next = spreadRecenterScrollTop({ ...base, currentScrollTop: 0, spreadTopWithinViewport: 230 });
    expect(next).toBe(0 + (230 - 129));
    expect(next!).toBeGreaterThan(0);
  });

  it("scrolls UP (decreases scrollTop) when the spread sits above center", () => {
    const next = spreadRecenterScrollTop({ ...base, currentScrollTop: 150, spreadTopWithinViewport: 60 });
    expect(next).toBe(150 + (60 - 129)); // 81
    expect(next!).toBeLessThan(150);
  });

  it("treats the threshold as inclusive (exactly threshold px → no change)", () => {
    expect(spreadRecenterScrollTop({ ...base, currentScrollTop: 10, spreadTopWithinViewport: 133 })).toBeNull(); // delta +4
    expect(spreadRecenterScrollTop({ ...base, currentScrollTop: 10, spreadTopWithinViewport: 134 })).not.toBeNull(); // delta +5
  });

  it("accounts for header height in the centering target", () => {
    // taller header pushes the target down → same spread position now reads as above-center
    const tall = spreadRecenterScrollTop({ ...base, headerHeight: 60, currentScrollTop: 0, spreadTopWithinViewport: 129 });
    const target = 60 + (259 - 60 - 28) / 2; // 145.5
    expect(tall).toBeCloseTo(0 + (129 - target), 5);
  });

  it("honors a custom threshold", () => {
    // delta +10 is within a 12px threshold → null
    expect(spreadRecenterScrollTop({ ...base, currentScrollTop: 0, spreadTopWithinViewport: 139, threshold: 12 })).toBeNull();
    expect(spreadRecenterScrollTop({ ...base, currentScrollTop: 0, spreadTopWithinViewport: 139, threshold: 2 })).not.toBeNull();
  });
});
