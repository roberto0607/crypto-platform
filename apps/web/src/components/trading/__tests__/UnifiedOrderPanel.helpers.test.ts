import { describe, it, expect } from "vitest";
import {
  computeQuickAmount,
  leverageRisk,
  openButtonLabel,
} from "@/components/trading/UnifiedOrderPanel";

// Deterministic formatter (avoids locale-dependent toLocaleString in assertions).
const fmt = (n: number) => "$" + n.toFixed(2);

describe("computeQuickAmount", () => {
  it("returns the fraction of balance floored to whole cents", () => {
    expect(computeQuickAmount(100000, 0.25)).toBe(25000);
    expect(computeQuickAmount(100000, 0.5)).toBe(50000);
    expect(computeQuickAmount(100000, 0.75)).toBe(75000);
    expect(computeQuickAmount(100000, 1)).toBe(100000);
  });

  it("floors to cents (never rounds up, never sub-cent)", () => {
    expect(computeQuickAmount(10.999, 1)).toBe(10.99);
    expect(computeQuickAmount(33.337, 0.5)).toBe(16.66); // 16.6685 → 16.66
  });

  it("returns 0 for zero/negative balance or fraction (no NaN)", () => {
    expect(computeQuickAmount(0, 0.5)).toBe(0);
    expect(computeQuickAmount(-100, 0.5)).toBe(0);
    expect(computeQuickAmount(100, 0)).toBe(0);
    expect(computeQuickAmount(NaN, 0.5)).toBe(0);
  });
});

describe("leverageRisk", () => {
  it("maps 1x/2x (and unknown values) to neutral", () => {
    expect(leverageRisk(1).tier).toBe("neutral");
    expect(leverageRisk(2).tier).toBe("neutral");
    expect(leverageRisk(4).tier).toBe("neutral"); // unknown
    expect(leverageRisk(7).tier).toBe("neutral"); // unknown
    expect(leverageRisk(0).tier).toBe("neutral");
  });

  it("maps 3x and 5x to warn (5x a stronger amber)", () => {
    expect(leverageRisk(3).tier).toBe("warn");
    expect(leverageRisk(5).tier).toBe("warn");
    expect(leverageRisk(3).color).toBe("#fbbf24");
    expect(leverageRisk(5).color).toBe("#f59e0b");
  });

  it("maps 10x to danger red", () => {
    expect(leverageRisk(10).tier).toBe("danger");
    expect(leverageRisk(10).color).toBe("#ef4444");
  });

  it("always returns a faintBorder for the unselected tint", () => {
    expect(leverageRisk(3).faintBorder).toBe("rgba(251,191,36,0.25)");
    expect(leverageRisk(10).faintBorder).toBe("rgba(239,68,68,0.25)");
    expect(leverageRisk(1).faintBorder).toBe("rgba(255,255,255,0.08)");
  });
});

describe("openButtonLabel", () => {
  it("enriches the plain OPEN with notional + base qty when qty > 0", () => {
    expect(openButtonLabel({ mode: "LONG", baseQty: 0.0158, effectiveUsd: 1000, baseSymbol: "BTC", fmtUsd: fmt }))
      .toBe("OPEN LONG · $1000.00 · 0.0158 BTC");
  });

  it("falls back to the plain label when qty is 0/empty", () => {
    expect(openButtonLabel({ mode: "LONG", baseQty: 0, effectiveUsd: 0, baseSymbol: "BTC", fmtUsd: fmt }))
      .toBe("OPEN LONG");
    expect(openButtonLabel({ mode: "SHORT", baseQty: 0, effectiveUsd: 500, baseSymbol: "ETH", fmtUsd: fmt }))
      .toBe("OPEN SHORT");
  });

  it("respects SHORT mode and rounds qty to 4 dp", () => {
    expect(openButtonLabel({ mode: "SHORT", baseQty: 0.12345678, effectiveUsd: 2000, baseSymbol: "ETH", fmtUsd: fmt }))
      .toBe("OPEN SHORT · $2000.00 · 0.1235 ETH");
  });

  it("uses the leverage-applied notional (effectiveUsd), not raw usd", () => {
    // effectiveUsd = usd * leverage; label must reflect the notional passed in.
    expect(openButtonLabel({ mode: "LONG", baseQty: 0.03, effectiveUsd: 3000, baseSymbol: "BTC", fmtUsd: fmt }))
      .toContain("$3000.00");
  });
});
