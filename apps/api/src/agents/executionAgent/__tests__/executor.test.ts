import { describe, it, expect } from "vitest";
import { isWithinExecutionTolerance } from "../executor";

/**
 * All 4 cases share entryPrice=50000, stopDistancePct=0.1 (10%) ->
 * tolerance = stopDistancePct * 0.5 = 0.05 (5%).
 *
 *   BUY limit  = entryPrice * (1 + tolerance) = 50000 * 1.05 = 52500
 *   SELL limit = entryPrice * (1 - tolerance) = 50000 * 0.95 = 47500
 *
 * Hand-computed expected values below the line for each case.
 */
describe("isWithinExecutionTolerance", () => {
  it("BUY favorable: price fell since entry -> within tolerance (true)", () => {
    // currentPrice=48000 <= BUY limit 52500 -> true
    expect(
      isWithinExecutionTolerance({
        side: "BUY",
        entryPrice: "50000",
        currentPrice: "48000",
        stopDistancePct: "0.1",
      }),
    ).toBe(true);
  });

  it("BUY unfavorable: price rose past tolerance since entry -> rejected (false)", () => {
    // currentPrice=53000 > BUY limit 52500 -> false
    expect(
      isWithinExecutionTolerance({
        side: "BUY",
        entryPrice: "50000",
        currentPrice: "53000",
        stopDistancePct: "0.1",
      }),
    ).toBe(false);
  });

  it("SELL favorable: price rose since entry -> within tolerance (true)", () => {
    // currentPrice=51000 >= SELL limit 47500 -> true
    expect(
      isWithinExecutionTolerance({
        side: "SELL",
        entryPrice: "50000",
        currentPrice: "51000",
        stopDistancePct: "0.1",
      }),
    ).toBe(true);
  });

  it("SELL unfavorable: price fell past tolerance since entry -> rejected (false)", () => {
    // currentPrice=47000 < SELL limit 47500 -> false
    expect(
      isWithinExecutionTolerance({
        side: "SELL",
        entryPrice: "50000",
        currentPrice: "47000",
        stopDistancePct: "0.1",
      }),
    ).toBe(false);
  });

  // ── Boundary: exactly at the limit ──
  // Inclusive (lte/gte) is an intentional design decision, not an
  // artifact of whichever comparison operator was convenient: landing
  // exactly at 50% of the stop distance means real risk taken EQUALS the
  // approved amount, not more than it, so it must not be rejected.

  it("BUY boundary: currentPrice exactly at the limit -> allowed (true)", () => {
    // currentPrice=52500 == BUY limit (50000 * 1.05) -> true
    expect(
      isWithinExecutionTolerance({
        side: "BUY",
        entryPrice: "50000",
        currentPrice: "52500",
        stopDistancePct: "0.1",
      }),
    ).toBe(true);
  });

  it("SELL boundary: currentPrice exactly at the limit -> allowed (true)", () => {
    // currentPrice=47500 == SELL limit (50000 * 0.95) -> true
    expect(
      isWithinExecutionTolerance({
        side: "SELL",
        entryPrice: "50000",
        currentPrice: "47500",
        stopDistancePct: "0.1",
      }),
    ).toBe(true);
  });
});
