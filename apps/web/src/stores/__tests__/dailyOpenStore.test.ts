import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useDailyOpenStore } from "@/stores/dailyOpenStore";

// dailyOpenStore caches the day's opening price per pair, stamped with the UTC
// date it was fetched. The stamp is computed inside setDailyOpen at call time
// (not at module load) so the midnight-rollover refetch can detect staleness.
// These tests pin that contract with fake timers for a deterministic "today".

describe("dailyOpenStore.setDailyOpen", () => {
  beforeEach(() => {
    useDailyOpenStore.setState({ opens: {} }); // singleton reset
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T12:00:00.000Z")); // fixed "today"
  });

  afterEach(() => {
    vi.useRealTimers(); // don't leak fake timers into other test files
  });

  it("stamps today's UTC date automatically", () => {
    useDailyOpenStore.getState().setDailyOpen("btc", 65000);
    expect(useDailyOpenStore.getState().opens["btc"]).toEqual({
      open: 65000,
      dateUTC: "2026-06-03",
    });
  });

  it("keeps multiple pairs isolated", () => {
    useDailyOpenStore.getState().setDailyOpen("btc", 65000);
    useDailyOpenStore.getState().setDailyOpen("eth", 3200);
    expect(useDailyOpenStore.getState().opens).toEqual({
      btc: { open: 65000, dateUTC: "2026-06-03" },
      eth: { open: 3200, dateUTC: "2026-06-03" },
    });
  });

  it("re-stamps dateUTC when called on a different UTC day", () => {
    useDailyOpenStore.getState().setDailyOpen("btc", 65000);
    expect(useDailyOpenStore.getState().opens["btc"]).toEqual({
      open: 65000,
      dateUTC: "2026-06-03",
    });

    // Advance past UTC midnight — the next stamp must reflect the new day,
    // proving dateUTC is computed at call time (midnight-rollover behavior).
    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    useDailyOpenStore.getState().setDailyOpen("btc", 66000);
    expect(useDailyOpenStore.getState().opens["btc"]).toEqual({
      open: 66000,
      dateUTC: "2026-06-04",
    });
  });
});
