import { TIERS, TIER_ORDER, type TierName } from "./competitionTypes.js";

/**
 * Returns ISO 8601 week identifier for a date, e.g. "2026-W11".
 */
export function getISOWeekId(date: Date): string {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    // Set to nearest Thursday (ISO week starts Monday, week belongs to year of its Thursday)
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * Returns Monday 00:00:00.000 UTC for the week containing the given date.
 */
export function getWeekStart(date: Date): Date {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const diff = day === 0 ? -6 : 1 - day; // shift to Monday
    d.setUTCDate(d.getUTCDate() + diff);
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

/**
 * Returns Sunday 23:59:59.999 UTC for the week containing the given date.
 */
export function getWeekEnd(date: Date): Date {
    const start = getWeekStart(date);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    end.setUTCHours(23, 59, 59, 999);
    return end;
}

/**
 * Display name for a weekly competition.
 * E.g. "Weekly - Rookie - Week of Mar 16"
 */
export function weeklyCompetitionName(tier: TierName, weekStart: Date): string {
    const month = weekStart.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    const day = weekStart.getUTCDate();
    const tierLabel = tier.charAt(0) + tier.slice(1).toLowerCase();
    return `Weekly - ${tierLabel} - Week of ${month} ${day}`;
}

/**
 * Returns the next tier up, or null if already LEGEND.
 */
export function tierUp(tier: TierName): TierName | null {
    const idx = TIER_ORDER[tier];
    return idx < TIERS.length - 1 ? TIERS[idx + 1] : null;
}

/**
 * Returns the next tier down, or null if already ROOKIE.
 */
export function tierDown(tier: TierName): TierName | null {
    const idx = TIER_ORDER[tier];
    return idx > 0 ? TIERS[idx - 1] : null;
}

/**
 * Get the Monday date for the NEXT week from the given date.
 */
export function getNextWeekStart(date: Date): Date {
    const thisWeekStart = getWeekStart(date);
    const next = new Date(thisWeekStart);
    next.setUTCDate(next.getUTCDate() + 7);
    return next;
}
