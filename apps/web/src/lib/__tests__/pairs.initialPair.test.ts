import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  pickInitialPairId,
  readLastPairSymbol,
  rememberPairSymbol,
  LAST_PAIR_STORAGE_KEY,
} from "@/lib/pairs";

// The server's /pairs list is the allowed list (BTC/ETH/SOL only).
const PAIRS = [
  { id: "eth", symbol: "ETH/USD" },
  { id: "btc", symbol: "BTC/USD" },
  { id: "sol", symbol: "SOL/USD" },
];

describe("pickInitialPairId", () => {
  it("defaults to BTC/USD — not alphabetical/first — when nothing is remembered", () => {
    expect(pickInitialPairId(PAIRS, null)).toBe("btc");
  });

  it("restores the remembered pair when it's still offered", () => {
    expect(pickInitialPairId(PAIRS, "SOL/USD")).toBe("sol");
  });

  it("falls back to BTC/USD when the remembered pair is no longer allowed", () => {
    expect(pickInitialPairId(PAIRS, "DOGE/USD")).toBe("btc");
  });

  it("falls back to the first pair if BTC/USD is somehow absent, and null for an empty list", () => {
    expect(pickInitialPairId([{ id: "eth", symbol: "ETH/USD" }], null)).toBe("eth");
    expect(pickInitialPairId([], "BTC/USD")).toBeNull();
  });
});

describe("last-pair persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips through localStorage", () => {
    expect(readLastPairSymbol()).toBeNull();
    rememberPairSymbol("ETH/USD");
    expect(localStorage.getItem(LAST_PAIR_STORAGE_KEY)).toBe("ETH/USD");
    expect(readLastPairSymbol()).toBe("ETH/USD");
    expect(pickInitialPairId(PAIRS)).toBe("eth");
  });

  it("never throws when storage is blocked — reads null, writes are dropped", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => rememberPairSymbol("SOL/USD")).not.toThrow();
    expect(readLastPairSymbol()).toBeNull();
    expect(pickInitialPairId(PAIRS)).toBe("btc");
    get.mockRestore();
    set.mockRestore();
  });
});
