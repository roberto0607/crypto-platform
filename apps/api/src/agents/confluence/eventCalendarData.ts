/**
 * FOMC and CPI release dates, 2019 → 2027, checked in (no live scraper).
 *
 * Sources, read 2026-11-16:
 * - FOMC scheduled meetings: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
 *   (2021–2027) and fomchistorical2019.htm / fomchistorical2020.htm. The date
 *   is the statement day (the meeting's last day). 2027 dates are tentative
 *   on the Fed's page ("tentative until confirmed at the meeting immediately
 *   preceding it").
 * - FOMC unscheduled rate decisions: 2020-03-03 and 2020-03-15 (fomchistorical2020.htm).
 *   Their announcement times (10:00 and 17:00 ET) are from the Fed's press
 *   releases, not the calendar page. The 2019-10-11 unscheduled statement
 *   (balance-sheet operations, no rate change) is deliberately left out.
 * - CPI: https://www.bls.gov/bls/news-release/cpi.htm (2019–2026 archive),
 *   https://www.bls.gov/schedule/news_release/cpi.htm and
 *   https://www.bls.gov/schedule/2027/home.htm. All 08:30 ET.
 *
 * Point-in-time rules (eventCalendar.ts):
 * - Only SCHEDULED events count toward "hours to next": nobody knew an
 *   unscheduled meeting was coming.
 * - The 2020-03-18 meeting was scheduled, then cancelled when the
 *   2020-03-15 decision was announced: it counts as "next" only before then
 *   and never as "since".
 * - CPI dates are the ACTUAL release dates. Before the 2025 shutdown they
 *   match the published schedule. Sep 2025 CPI came out 2025-10-24 (its
 *   original date isn't on the pages read) and Oct 2025 CPI was never
 *   published. Both are out of sample.
 */

export interface CalendarEvent {
  kind: "fomc" | "cpi";
  /** Local US Eastern date + time of the release. */
  date: string; // YYYY-MM-DD
  timeEt: string; // HH:MM
  scheduled: boolean;
  /** Set when a scheduled event was cancelled: the UTC instant it was. */
  cancelledAt?: string;
}

const FOMC_SCHEDULED: string[] = [
  "2019-01-30", "2019-03-20", "2019-05-01", "2019-06-19", "2019-07-31", "2019-09-18", "2019-10-30", "2019-12-11",
  "2020-01-29", "2020-04-29", "2020-06-10", "2020-07-29", "2020-09-16", "2020-11-05", "2020-12-16",
  "2021-01-27", "2021-03-17", "2021-04-28", "2021-06-16", "2021-07-28", "2021-09-22", "2021-11-03", "2021-12-15",
  "2022-01-26", "2022-03-16", "2022-05-04", "2022-06-15", "2022-07-27", "2022-09-21", "2022-11-02", "2022-12-14",
  "2023-02-01", "2023-03-22", "2023-05-03", "2023-06-14", "2023-07-26", "2023-09-20", "2023-11-01", "2023-12-13",
  "2024-01-31", "2024-03-20", "2024-05-01", "2024-06-12", "2024-07-31", "2024-09-18", "2024-11-07", "2024-12-18",
  "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18", "2025-07-30", "2025-09-17", "2025-10-29", "2025-12-10",
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
  "2027-01-27", "2027-03-17", "2027-04-28", "2027-06-09", "2027-07-28", "2027-09-15", "2027-10-27", "2027-11-17",
];

const CPI_RELEASES: string[] = [
  "2019-02-13", "2019-03-12", "2019-04-10", "2019-05-10", "2019-06-12", "2019-07-11", "2019-08-13", "2019-09-12", "2019-10-10", "2019-11-13", "2019-12-11",
  "2020-01-14", "2020-02-13", "2020-03-11", "2020-04-10", "2020-05-12", "2020-06-10", "2020-07-14", "2020-08-12", "2020-09-11", "2020-10-13", "2020-11-12", "2020-12-10",
  "2021-01-13", "2021-02-10", "2021-03-10", "2021-04-13", "2021-05-12", "2021-06-10", "2021-07-13", "2021-08-11", "2021-09-14", "2021-10-13", "2021-11-10", "2021-12-10",
  "2022-01-12", "2022-02-10", "2022-03-10", "2022-04-12", "2022-05-11", "2022-06-10", "2022-07-13", "2022-08-10", "2022-09-13", "2022-10-13", "2022-11-10", "2022-12-13",
  "2023-01-12", "2023-02-14", "2023-03-14", "2023-04-12", "2023-05-10", "2023-06-13", "2023-07-12", "2023-08-10", "2023-09-13", "2023-10-12", "2023-11-14", "2023-12-12",
  "2024-01-11", "2024-02-13", "2024-03-12", "2024-04-10", "2024-05-15", "2024-06-12", "2024-07-11", "2024-08-14", "2024-09-11", "2024-10-10", "2024-11-13", "2024-12-11",
  "2025-01-15", "2025-02-12", "2025-03-12", "2025-04-10", "2025-05-13", "2025-06-11", "2025-07-15", "2025-08-12", "2025-09-11", "2025-10-24", "2025-12-18",
  "2026-01-13", "2026-02-13", "2026-03-11", "2026-04-10", "2026-05-12", "2026-06-10", "2026-07-14", "2026-08-12", "2026-09-11", "2026-10-14", "2026-11-10", "2026-12-10",
  "2027-01-13", "2027-02-11", "2027-03-10", "2027-04-13", "2027-05-12", "2027-06-10", "2027-07-14", "2027-08-11", "2027-09-14", "2027-10-14", "2027-11-10", "2027-12-10",
];

export const CALENDAR_EVENTS: CalendarEvent[] = [
  ...FOMC_SCHEDULED.map((date): CalendarEvent => ({ kind: "fomc", date, timeEt: "14:00", scheduled: true })),
  { kind: "fomc", date: "2020-03-18", timeEt: "14:00", scheduled: true, cancelledAt: "2020-03-15T21:00:00Z" },
  { kind: "fomc", date: "2020-03-03", timeEt: "10:00", scheduled: false },
  { kind: "fomc", date: "2020-03-15", timeEt: "17:00", scheduled: false },
  ...CPI_RELEASES.map((date): CalendarEvent => ({ kind: "cpi", date, timeEt: "08:30", scheduled: true })),
];
