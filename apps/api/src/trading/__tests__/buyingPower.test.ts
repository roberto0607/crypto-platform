/**
 * buyingPower.test.ts: the 2× rule (QA F5). The cases live in
 * buyingPowerCases.json, which the web AVAILABLE display is tested on too.
 */
import { describe, it, expect } from "vitest";
import { buyingPower, exposureQty, isReduceOnly } from "../buyingPower";
import { D } from "../../utils/decimal";
import cases from "./buyingPowerCases.json";

const priceOf = (assetId: string) => {
    const p = (cases.prices as Record<string, string>)[assetId];
    return p ? D(p) : null;
};

describe("buyingPower (shared cases)", () => {
    it.each(cases.cases)("$name", ({ wallets, expected }) => {
        const bp = buyingPower(
            cases.quoteAssetId,
            wallets.map(([assetId, balance, reserved]) => ({ assetId, balance, reserved })),
            priceOf,
        );
        if (expected === null) expect(bp).toBeNull();
        else expect(bp!.toString()).toBe(D(expected).toString());
    });
});

describe("exposureQty", () => {
    it("is 2x the short plus resting sells beyond holdings", () => {
        expect(exposureQty({ balance: "-1", reserved: "0.5" }).toString()).toBe("2.5");
        expect(exposureQty({ balance: "2", reserved: "1" }).toString()).toBe("0");
    });
});

describe("isReduceOnly", () => {
    it("SELL: only holdings not already committed to other sells", () => {
        expect(isReduceOnly("SELL", D("1"), { balance: "1", reserved: "0" })).toBe(true);
        expect(isReduceOnly("SELL", D("1"), { balance: "1", reserved: "0.5" })).toBe(false);
        expect(isReduceOnly("SELL", D("1.5"), { balance: "1", reserved: "0" })).toBe(false); // flips short
        expect(isReduceOnly("SELL", D("0.1"), { balance: "-1", reserved: "0" })).toBe(false); // adds to a short
    });

    it("BUY: up to the short", () => {
        expect(isReduceOnly("BUY", D("1"), { balance: "-1", reserved: "0" })).toBe(true);
        expect(isReduceOnly("BUY", D("1.1"), { balance: "-1", reserved: "0" })).toBe(false); // flips long
        expect(isReduceOnly("BUY", D("0.1"), { balance: "0", reserved: "0" })).toBe(false);
    });
});
