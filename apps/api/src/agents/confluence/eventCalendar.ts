/**
 * Event features from the checked-in calendar (eventCalendarData.ts):
 * hours to the next scheduled FOMC/CPI release, hours since the last one
 * that happened, and whether one falls inside the next 7 days.
 */
import { CALENDAR_EVENTS, type CalendarEvent } from "./eventCalendarData";
import { FEATURE_PARAMS as P } from "./featureParams";

/** Day of month of the n-th Sunday (1-based) of a month, UTC calendar. */
function nthSunday(year: number, month0: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, month0, 1)).getUTCDay();
  return 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
}

/**
 * US Eastern local date + time → UTC epoch seconds. Daylight time (UTC−4)
 * runs from the 2nd Sunday of March to the 1st Sunday of November (rules
 * since 2007); every release here is well past the 02:00 switch.
 */
export function etToUtc(date: string, timeEt: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = timeEt.split(":").map(Number) as [number, number];
  if (!y || !m || !d || hh === undefined || mm === undefined) throw new Error(`bad ET date/time ${date} ${timeEt}`);
  const dstStart = Date.UTC(y, 2, nthSunday(y, 2, 2));
  const dstEnd = Date.UTC(y, 10, nthSunday(y, 10, 1));
  const day = Date.UTC(y, m - 1, d);
  const offsetH = day >= dstStart && day < dstEnd ? 4 : 5;
  return Date.UTC(y, m - 1, d, hh + offsetH, mm) / 1000;
}

export interface EventInstant {
  time: number;
  scheduled: boolean;
  /** UTC seconds the event stopped being expected (cancelled); null = it happened. */
  cancelledAt: number | null;
}

const cache = new Map<string, EventInstant[]>();

export function eventInstants(kind: CalendarEvent["kind"], events: CalendarEvent[] = CALENDAR_EVENTS): EventInstant[] {
  const key = events === CALENDAR_EVENTS ? kind : "";
  const hit = key ? cache.get(key) : undefined;
  if (hit) return hit;
  const out = events
    .filter((e) => e.kind === kind)
    .map((e) => ({
      time: etToUtc(e.date, e.timeEt),
      scheduled: e.scheduled,
      cancelledAt: e.cancelledAt ? Date.parse(e.cancelledAt) / 1000 : null,
    }))
    .sort((a, b) => a.time - b.time);
  if (key) cache.set(key, out);
  return out;
}

export interface EventFeatures {
  e_hours_to_fomc: number | null;
  e_hours_since_fomc: number | null;
  e_fomc_within_7d: boolean | null;
  e_hours_to_cpi: number | null;
  e_hours_since_cpi: number | null;
  e_cpi_within_7d: boolean | null;
}

function toAndSince(list: EventInstant[], t: number): { to: number | null; since: number | null } {
  let to: number | null = null;
  let since: number | null = null;
  for (const e of list) {
    if (e.time <= t) {
      // happened (a cancelled one never did)
      if (e.cancelledAt === null) since = (t - e.time) / 3600;
    } else if (to === null && e.scheduled && (e.cancelledAt === null || t < e.cancelledAt)) {
      to = (e.time - t) / 3600;
    }
  }
  return { to, since };
}

/** Event features at instant `t` (UTC seconds): only what was known then. */
export function eventFeaturesAt(t: number, events: CalendarEvent[] = CALENDAR_EVENTS): EventFeatures {
  const f = toAndSince(eventInstants("fomc", events), t);
  const c = toAndSince(eventInstants("cpi", events), t);
  const within = (h: number | null) => (h === null ? null : h <= P.eventWindowHours);
  return {
    e_hours_to_fomc: f.to,
    e_hours_since_fomc: f.since,
    e_fomc_within_7d: within(f.to),
    e_hours_to_cpi: c.to,
    e_hours_since_cpi: c.since,
    e_cpi_within_7d: within(c.to),
  };
}
