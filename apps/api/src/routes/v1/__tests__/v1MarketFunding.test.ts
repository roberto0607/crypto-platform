import { describe, it, expect } from "vitest";
import { parseGateFundingHistory } from "../v1Market";

// Audit 2026-11 B-01: `rate` (current) was the raw Gate.io fraction while every
// `history` point was pre-multiplied by 100, so the panel showed the latest in
// one unit and a hovered bar in another (+0.0100% vs "+0.5500%" for r=0.000055).
describe("funding-rate history units", () => {
    it("history points are raw fractions — the same unit as `rate`", () => {
        // Gate.io returns newest first; history is charted oldest first.
        const raw = [
            { t: 1793664000, r: "0.0001" },
            { t: 1793635200, r: "0.000055" },
            { t: 1793606400, r: "-0.00002" },
        ];
        expect(parseGateFundingHistory(raw)).toEqual([
            { time: 1793606400, value: -0.00002 },
            { time: 1793635200, value: 0.000055 },
            { time: 1793664000, value: 0.0001 },
        ]);
    });

    it("the latest history point equals a current rate quoted the same way", () => {
        const currentRate = parseFloat("0.0001"); // contract.funding_rate, as `rate`
        const history = parseGateFundingHistory([{ t: 1, r: "0.0001" }]);
        expect(history.at(-1)!.value).toBe(currentRate);
    });
});
