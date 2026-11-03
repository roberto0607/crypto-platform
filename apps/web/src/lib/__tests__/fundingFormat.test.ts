import { describe, it, expect } from "vitest";
import { formatFundingRate } from "@/lib/fundingFormat";

// Audit 2026-11 B-01: funding values are raw fractions everywhere (API `rate`
// and `history[].value`); this is the only place they become a percent.
describe("formatFundingRate", () => {
    it("formats a raw fraction as a signed 4-dp percent", () => {
        expect(formatFundingRate(0.0001)).toBe("+0.0100%");
        expect(formatFundingRate(0.000055)).toBe("+0.0055%"); // was shown as "+0.5500%" on hover
        expect(formatFundingRate(-0.00002)).toBe("-0.0020%"); // was shown as "-0.2000%"
        expect(formatFundingRate(0)).toBe("+0.0000%");
    });

    it("latest and hovered values of the same rate read identically", () => {
        const latest = 0.0001;               // entry.rate
        const hoveredHistoryPoint = 0.0001;  // entry.history[i].value
        expect(formatFundingRate(hoveredHistoryPoint)).toBe(formatFundingRate(latest));
    });
});
