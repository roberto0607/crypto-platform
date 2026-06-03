import { describe, it, expect, beforeEach } from "vitest";
import { usePairPricesStore } from "@/stores/pairPricesStore";

// pairPricesStore holds the live per-pair price, decoupled from the `pairs`
// array so a price tick re-renders only that pair's subscribers (not every
// consumer of `pairs`). These tests pin the setPairPrice reducer contract.

describe("pairPricesStore.setPairPrice", () => {
  beforeEach(() => {
    // Zustand stores are module singletons — reset between tests.
    usePairPricesStore.setState({ prices: {} });
  });

  it("writes the price under the given pairId", () => {
    usePairPricesStore.getState().setPairPrice("btc", 65000);
    expect(usePairPricesStore.getState().prices["btc"]).toBe(65000);
  });

  it("does not affect other pairs (isolation)", () => {
    usePairPricesStore.getState().setPairPrice("btc", 65000);
    usePairPricesStore.getState().setPairPrice("eth", 3200);
    expect(usePairPricesStore.getState().prices).toEqual({
      btc: 65000,
      eth: 3200,
    });
  });

  it("overwrites the same pairId (last-write-wins)", () => {
    usePairPricesStore.getState().setPairPrice("btc", 65000);
    usePairPricesStore.getState().setPairPrice("btc", 64000);
    expect(usePairPricesStore.getState().prices["btc"]).toBe(64000);
  });

  it("returns undefined for an unset pairId", () => {
    expect(usePairPricesStore.getState().prices["sol"]).toBeUndefined();
  });
});
