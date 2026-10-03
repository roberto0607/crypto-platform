import { describe, it, expect } from "vitest";
import { toTickerItems, tickerLoop, formatTickerPrice } from "@/hooks/usePublicTicker";

describe("toTickerItems", () => {
  it("formats real API rows into ticker rows", () => {
    expect(
      toTickerItems([
        { symbol: "BTC/USD", price: "84220.44", change24hPct: 2.31 },
        { symbol: "SOL/USD", price: "142.8", change24hPct: -0.7 },
        { symbol: "ETH/USD", price: "3941.12", change24hPct: null },
      ]),
    ).toEqual([
      { sym: "BTC", price: "$84,220.44", chg: "+2.31%", up: true },
      { sym: "SOL", price: "$142.80", chg: "-0.70%", up: false },
      { sym: "ETH", price: "$3,941.12", chg: "—", up: true },
    ]);
  });

  it("drops rows with no price yet instead of inventing one", () => {
    expect(toTickerItems([{ symbol: "BTC/USD", price: null, change24hPct: null }])).toEqual([]);
  });

  it("uses 4 decimals below $1", () => {
    expect(formatTickerPrice(0.18224)).toBe("$0.1822");
  });
});

describe("tickerLoop", () => {
  it("returns two identical halves (the CSS loop translates -50%), empty in → empty out", () => {
    const loop = tickerLoop(["a", "b", "c"]);
    expect(loop).toHaveLength(18);
    expect(loop.slice(0, 9)).toEqual(loop.slice(9));
    expect(tickerLoop([])).toEqual([]);
  });
});
