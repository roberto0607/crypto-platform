/**
 * The journal's close-reason badge (closed_trades.close_reason, recorded by
 * the server since leverage PR 6a). MANUAL / unknown / older rows: no badge.
 */
import { describe, it, expect } from "vitest";
import { closeReasonBadge } from "@/lib/closeReason";

describe("closeReasonBadge", () => {
  it("LIQUIDATION is a red LIQUIDATED badge", () => {
    expect(closeReasonBadge("LIQUIDATION")).toEqual({ label: "LIQUIDATED", color: "#ff3b3b" });
  });
  it("TP / SL / TRAILING", () => {
    expect(closeReasonBadge("TP")?.label).toBe("TP");
    expect(closeReasonBadge("SL")?.label).toBe("SL");
    expect(closeReasonBadge("TRAILING")?.label).toBe("TRAILING STOP");
  });
  it("MANUAL, null (closed before the server recorded it) and unknown: none", () => {
    expect(closeReasonBadge("MANUAL")).toBeNull();
    expect(closeReasonBadge(null)).toBeNull();
    expect(closeReasonBadge(undefined)).toBeNull();
    expect(closeReasonBadge("SOMETHING_NEW")).toBeNull();
  });
});
