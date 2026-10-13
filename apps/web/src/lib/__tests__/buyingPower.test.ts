/**
 * The AVAILABLE display runs the server's buying-power cases, so the number
 * the user sees is the number the order check enforces.
 */
import { describe, it, expect } from "vitest";
import { buyingPower } from "@/lib/buyingPower";
import cases from "../../../../api/src/trading/__tests__/buyingPowerCases.json";

const prices = cases.prices as Record<string, string>;

describe("buyingPower (shared with the API)", () => {
  it.each(cases.cases)("$name", ({ wallets, expected }) => {
    const bp = buyingPower(
      cases.quoteAssetId,
      wallets.map(([assetId, balance, reserved]) => ({ assetId: assetId!, balance: balance!, reserved: reserved! })),
      (assetId) => (prices[assetId] ? Number(prices[assetId]) : null),
    );
    if (expected === null) expect(bp).toBeNull();
    else expect(bp).toBeCloseTo(Number(expected), 8);
  });
});
