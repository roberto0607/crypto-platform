import { describe, it, expect } from "vitest";
import { classifyRegime } from "../regimeClassifier";

describe("classifyRegime", () => {
  it("classifies trending when EMA slope crosses the threshold, regardless of ATR", () => {
    const result = classifyRegime(0.5, 3, false); // low ATR, strong slope
    expect(result.regime).toBe("trending");
  });

  it("classifies trending on a strong downward slope too (uses absolute value)", () => {
    const result = classifyRegime(0.5, -3, false);
    expect(result.regime).toBe("trending");
  });

  it("classifies volatile-chop when ATR crosses the threshold but slope does not", () => {
    const result = classifyRegime(4, 0.5, false);
    expect(result.regime).toBe("volatile-chop");
  });

  it("classifies ranging when neither ATR nor slope crosses its threshold", () => {
    const result = classifyRegime(0.5, 0.5, false);
    expect(result.regime).toBe("ranging");
  });

  it("prefers trending over volatile-chop when both thresholds are crossed", () => {
    const result = classifyRegime(5, 3, false);
    expect(result.regime).toBe("trending");
  });

  it("lowers the volatile-chop bar during extreme macro fear/greed", () => {
    // ATR 2.5 is below the normal 3% threshold but above the
    // macro-adjusted 2% threshold (3 - 1 adjustment).
    const normal = classifyRegime(2.5, 0.5, false);
    const extreme = classifyRegime(2.5, 0.5, true);
    expect(normal.regime).toBe("ranging");
    expect(extreme.regime).toBe("volatile-chop");
  });

  it("does not change the trend threshold based on macro extremity", () => {
    const normal = classifyRegime(0.5, 1.5, false);
    const extreme = classifyRegime(0.5, 1.5, true);
    expect(normal.regime).toBe("ranging");
    expect(extreme.regime).toBe("ranging");
  });

  it("confidence is within [0, 1] across a range of inputs", () => {
    const cases: [number, number, boolean][] = [
      [0, 0, false],
      [10, 10, false],
      [-10, -10, true],
      [3, 2, true],
      [0.01, 0.01, false],
    ];
    for (const [atr, slope, macro] of cases) {
      const { confidence } = classifyRegime(atr, slope, macro);
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
    }
  });

  it("ranging confidence is highest when both signals are near zero", () => {
    const nearZero = classifyRegime(0.01, 0.01, false);
    const nearThreshold = classifyRegime(2.9, 1.9, false);
    expect(nearZero.regime).toBe("ranging");
    expect(nearThreshold.regime).toBe("ranging");
    expect(nearZero.confidence).toBeGreaterThan(nearThreshold.confidence);
  });
});
