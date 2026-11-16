import { describe, it, expect } from "vitest";
import { CALENDAR_EVENTS } from "../eventCalendarData";
import { etToUtc, eventFeaturesAt, eventInstants } from "../eventCalendar";

const t = (iso: string) => Date.parse(iso) / 1000;

describe("etToUtc", () => {
  it("uses EST (UTC−5) outside US daylight time and EDT (UTC−4) inside it", () => {
    expect(etToUtc("2020-03-03", "10:00")).toBe(t("2020-03-03T15:00:00Z")); // before 2nd Sunday of March (03-08)
    expect(etToUtc("2020-03-15", "17:00")).toBe(t("2020-03-15T21:00:00Z")); // after it
    expect(etToUtc("2019-10-30", "14:00")).toBe(t("2019-10-30T18:00:00Z")); // before 1st Sunday of Nov (11-03)
    expect(etToUtc("2019-11-13", "08:30")).toBe(t("2019-11-13T13:30:00Z")); // after it
    expect(etToUtc("2021-03-14", "08:30")).toBe(t("2021-03-14T12:30:00Z")); // DST start day itself
    expect(etToUtc("2021-11-07", "08:30")).toBe(t("2021-11-07T13:30:00Z")); // DST end day itself
  });
});

describe("the checked-in calendar", () => {
  it("has no duplicate events and every date parses", () => {
    const keys = CALENDAR_EVENTS.map((e) => `${e.kind}:${e.date}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of CALENDAR_EVENTS) expect(Number.isFinite(etToUtc(e.date, e.timeEt))).toBe(true);
  });

  it("has 8 scheduled FOMC decisions a year (2020: 7 held + the cancelled one) and 12 CPI releases a year in sample", () => {
    for (const y of ["2019", "2021", "2022", "2023"]) {
      expect(CALENDAR_EVENTS.filter((e) => e.kind === "fomc" && e.scheduled && e.date.startsWith(y))).toHaveLength(8);
    }
    expect(CALENDAR_EVENTS.filter((e) => e.kind === "fomc" && e.scheduled && e.date.startsWith("2020"))).toHaveLength(8);
    for (const y of ["2020", "2021", "2022", "2023"]) {
      expect(CALENDAR_EVENTS.filter((e) => e.kind === "cpi" && e.date.startsWith(y))).toHaveLength(12);
    }
  });

  it("covers at least 60 days ahead of today for both kinds (extend the calendar when this fails)", () => {
    const horizon = Date.now() / 1000 + 60 * 86_400;
    for (const kind of ["fomc", "cpi"] as const) {
      const lastScheduled = Math.max(...eventInstants(kind).filter((e) => e.scheduled).map((e) => e.time));
      expect(lastScheduled).toBeGreaterThan(horizon);
    }
  });
});

describe("eventFeaturesAt", () => {
  it("counts hours to the next SCHEDULED event and since the last event that happened", () => {
    // 2020-03-10 00:00Z: next scheduled FOMC was 2020-03-18 14:00 EDT (18:00Z); the last
    // one held was the unscheduled 2020-03-03 15:00Z cut.
    const f = eventFeaturesAt(t("2020-03-10T00:00:00Z"));
    expect(f.e_hours_to_fomc).toBe(8 * 24 + 18);
    expect(f.e_hours_since_fomc).toBe(6 * 24 + 9);
    expect(f.e_fomc_within_7d).toBe(false);
  });

  it("never counts an unscheduled meeting as 'next', and drops a cancelled one once it was cancelled", () => {
    // 2020-03-14: the 03-15 emergency cut was not knowable; the next scheduled is still 03-18.
    expect(eventFeaturesAt(t("2020-03-14T00:00:00Z")).e_hours_to_fomc).toBe(4 * 24 + 18);
    // 2020-03-16 00:00Z: 03-18 was cancelled on 03-15 21:00Z → next is 2020-04-29 18:00Z.
    const f = eventFeaturesAt(t("2020-03-16T00:00:00Z"));
    expect(f.e_hours_to_fomc).toBe((t("2020-04-29T18:00:00Z") - t("2020-03-16T00:00:00Z")) / 3600);
    expect(f.e_hours_since_fomc).toBe(3);
    // and after 03-18 passes, the cancelled meeting never becomes "since"
    expect(eventFeaturesAt(t("2020-03-20T00:00:00Z")).e_hours_since_fomc).toBe(4 * 24 + 3);
  });

  it("an event at the exact instant counts as 'since' (0 h), not 'to'", () => {
    const f = eventFeaturesAt(t("2023-06-13T12:30:00Z")); // CPI 08:30 EDT
    expect(f.e_hours_since_cpi).toBe(0);
    expect(f.e_hours_to_cpi).toBe((t("2023-07-12T12:30:00Z") - t("2023-06-13T12:30:00Z")) / 3600);
  });

  it("flags an event inside the next 7 days", () => {
    const f = eventFeaturesAt(t("2023-06-08T12:30:00Z"));
    expect(f.e_hours_to_cpi).toBe(5 * 24);
    expect(f.e_cpi_within_7d).toBe(true);
  });

  it("is null before the calendar's first event of a kind", () => {
    const f = eventFeaturesAt(t("2019-01-01T00:00:00Z"));
    expect(f.e_hours_since_cpi).toBeNull();
    expect(f.e_hours_since_fomc).toBeNull();
    expect(f.e_hours_to_cpi).not.toBeNull();
  });
});
