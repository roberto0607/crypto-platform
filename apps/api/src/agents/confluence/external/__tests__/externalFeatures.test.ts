import { describe, it, expect } from "vitest";
import type { Point } from "../../../../indicators/shared";
import { downsampleHourly } from "../externalSeriesRepo";
import { externalFeaturesAt, prepareExternal } from "../externalFeatures";

const H = 3_600;
const D = 86_400;
const t0 = Date.parse("2021-01-01T00:00:00Z") / 1000;

const hourly = (from: number, hours: number, f: (i: number) => number): Point[] =>
  Array.from({ length: hours }, (_, i) => ({ time: from + i * H, value: f(i) }));

describe("downsampleHourly", () => {
  it("keeps the last point of each UTC hour, stamped at its own time", () => {
    const pts = [
      { time: t0, value: 1 }, { time: t0 + 1_500, value: 2 }, { time: t0 + 3_300, value: 3 },
      { time: t0 + H, value: 4 },
    ];
    expect(downsampleHourly(pts)).toEqual([{ time: t0 + 3_300, value: 3 }, { time: t0 + H, value: 4 }]);
  });
});

describe("funding", () => {
  const year = 366 * 24;
  const funding = hourly(t0 - year * H, year + 48, (i) => (i % 100) / 1e4);
  const close = t0 + 24 * H;

  it("last 8h rate at or before the close, 7-day mean, 1-year rank among earlier hours", () => {
    const f = externalFeaturesAt(close, prepareExternal({ funding }));
    const upto = funding.filter((p) => p.time <= close);
    const last = upto[upto.length - 1]!;
    expect(f.values.p_funding_8h).toBe(last.value);
    const week = upto.filter((p) => p.time > close - 7 * D);
    expect(f.values.p_funding_avg_7d).toBeCloseTo(week.reduce((s, p) => s + p.value, 0) / week.length, 15);
    const prior = funding.filter((p) => p.time >= close - 365 * D && p.time < last.time).map((p) => p.value);
    const rank = (prior.filter((v) => v < last.value).length + 0.5 * prior.filter((v) => v === last.value).length) / prior.length;
    expect(f.values.p_funding_rank_1y).toBeCloseTo(rank, 15);
  });

  it("is stale (NULL) when the last point is over 2h old, and warm-up before the series starts", () => {
    const f = externalFeaturesAt(t0 + 60 * 24 * H, prepareExternal({ funding }));
    expect(f.values.p_funding_8h).toBeNull();
    expect(f.missing.p_funding_8h).toBe("stale");
    const g = externalFeaturesAt(funding[0]!.time - H, prepareExternal({ funding }));
    expect(g.missing.p_funding_8h).toBe("warmup");
    expect(g.missing.p_funding_avg_7d).toBe("warmup");
    expect(externalFeaturesAt(funding[0]!.time + 30 * D, prepareExternal({ funding })).missing.p_funding_rank_1y).toBe("warmup");
  });

  it("no source loaded = the columns are left for the writer (not computed)", () => {
    const f = externalFeaturesAt(close, prepareExternal({}));
    expect(f.values.p_funding_8h).toBeUndefined();
    expect(f.values.s_fng).toBeUndefined();
  });
});

describe("open interest", () => {
  const oi = hourly(t0, 24 * 10, (i) => 1e9 * (1 + i / 1_000));
  const close = t0 + 9 * D;

  it("latest OI and its 24h / 7d % change", () => {
    const f = externalFeaturesAt(close, prepareExternal({ oi }));
    const at = (t: number) => oi.find((p) => p.time === t)!.value;
    expect(f.values.p_oi_usd).toBe(at(close));
    expect(f.values.p_oi_chg_24h).toBeCloseTo(at(close) / at(close - D) - 1, 15);
    expect(f.values.p_oi_chg_7d).toBeCloseTo(at(close) / at(close - 7 * D) - 1, 15);
  });

  it("a change is NULL ('gap') when the earlier point isn't within 2h of its target", () => {
    const holed = oi.filter((p) => p.time > close - D + 2 * H || p.time < close - D - 3 * H);
    const f = externalFeaturesAt(close, prepareExternal({ oi: holed }));
    expect(f.values.p_oi_chg_24h).toBeNull();
    expect(f.missing.p_oi_chg_24h).toBe("gap");
    expect(f.values.p_oi_chg_7d).not.toBeNull();
  });

  it("gives the same values whether the series is stored at full 5-minute resolution or at 1h", () => {
    const full: Point[] = [];
    for (let t = t0; t < t0 + 10 * D; t += 300) full.push({ time: t, value: 1e9 + (t - t0) * 7 + ((t / 300) % 13) });
    const a = externalFeaturesAt(close + 5 * 60, prepareExternal({ oi: full }));
    const b = externalFeaturesAt(close + 5 * 60, prepareExternal({ oi: downsampleHourly(full) }));
    expect(a).toEqual(b);
    expect(a.values.p_oi_usd).not.toBeNull();
  });
});

describe("Fear & Greed", () => {
  const fng = Array.from({ length: 30 }, (_, i) => ({ time: t0 + i * D, value: 20 + i }));

  it("uses the previous UTC day's value (one-day lag) and its 7-day change", () => {
    // close at day 10, 04:00 → value of day 9
    const f = externalFeaturesAt(t0 + 10 * D + 4 * H, prepareExternal({ fng }));
    expect(f.values.s_fng).toBe(29);
    expect(f.values.s_fng_chg_7d).toBe(7);
    // a close exactly at day 10 00:00 still gets day 9 (day 10's value isn't known yet)
    expect(externalFeaturesAt(t0 + 10 * D, prepareExternal({ fng })).values.s_fng).toBe(29);
  });

  it("is stale after 3 days without a value, and the change needs the exact day a week earlier", () => {
    expect(externalFeaturesAt(t0 + 40 * D, prepareExternal({ fng })).missing.s_fng).toBe("stale");
    const holed = fng.filter((p) => p.time !== t0 + 2 * D);
    const f = externalFeaturesAt(t0 + 10 * D + 4 * H, prepareExternal({ fng: holed }));
    expect(f.values.s_fng).toBe(29);
    expect(f.values.s_fng_chg_7d).toBeNull();
    expect(f.missing.s_fng_chg_7d).toBe("gap");
  });
});

describe("EXTERNAL_SERIES_RESOLUTION", () => {
  it("defaults to 1h, accepts full, and rejects anything else", async () => {
    const { parseExternalSeriesResolution } = await import("../../../../config");
    expect(parseExternalSeriesResolution(undefined)).toBe("1h");
    expect(parseExternalSeriesResolution(" 1h ")).toBe("1h");
    expect(parseExternalSeriesResolution("full")).toBe("full");
    expect(() => parseExternalSeriesResolution("5m")).toThrow(/EXTERNAL_SERIES_RESOLUTION/);
  });
});
