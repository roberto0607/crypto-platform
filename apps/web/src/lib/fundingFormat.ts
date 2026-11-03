/**
 * The one funding-rate formatter. Every funding value the app holds is a RAW
 * fraction (0.0001 = 0.01%) — the API's `rate` and `history[].value` alike —
 * and this is the only place it becomes a percent (audit 2026-11 B-01).
 */
export function formatFundingRate(fraction: number): string {
    return (fraction >= 0 ? "+" : "") + (fraction * 100).toFixed(4) + "%";
}
