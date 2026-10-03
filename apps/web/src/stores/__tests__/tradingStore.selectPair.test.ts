import { describe, it, expect, beforeEach, vi } from "vitest";
import { useTradingStore } from "@/stores/tradingStore";
import { useAppStore } from "@/stores/appStore";
import { LAST_PAIR_STORAGE_KEY } from "@/lib/pairs";
import type { TradingPair } from "@/types/api";

const pair = (id: string, symbol: string) => ({ id, symbol }) as unknown as TradingPair;

describe("tradingStore.selectPair remembers the pick across refresh", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ pairs: [pair("btc", "BTC/USD"), pair("sol", "SOL/USD")] });
    // selectPair kicks off fetches for the new pair; stub them out.
    useTradingStore.setState({
      refreshBook: vi.fn(),
      refreshSnapshot: vi.fn(),
      refreshOpenOrders: vi.fn(),
    } as never);
  });

  it("stores the selected pair's SYMBOL under tradr_last_pair", () => {
    useTradingStore.getState().selectPair("sol");
    expect(useTradingStore.getState().selectedPairId).toBe("sol");
    expect(localStorage.getItem(LAST_PAIR_STORAGE_KEY)).toBe("SOL/USD");
  });

  it("doesn't remember an id the server didn't offer", () => {
    useTradingStore.getState().selectPair("unknown-id");
    expect(localStorage.getItem(LAST_PAIR_STORAGE_KEY)).toBeNull();
  });
});
