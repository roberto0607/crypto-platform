/**
 * The AVAILABLE display runs the server's buying-power cases, so the number
 * the user sees is the number the order check enforces.
 */
import { describe, it, expect } from "vitest";
import { buyingPower } from "@/lib/buyingPower";
// A copy of the API's case table: the web Docker build only sees apps/web.
// The API test fails if the two copies differ.
import cases from "./buyingPowerCases.json";

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
