import { z } from "zod";

/**
 * `?scope=` on the open-order and trigger lists: which book of the user's the
 * caller is looking at. Named by the request, never inferred from whether the
 * user happens to be in a match.
 *
 *   absent        every row (Journal, replay)
 *   free          rows outside any match
 *   <match uuid>  that match's rows
 */
export type MatchScope = string | null | undefined;

const scopeParam = z.union([z.literal("free"), z.string().uuid()]);

/** The repo filter for a raw `scope` value; "invalid" for anything else. */
export function parseMatchScope(raw: unknown): MatchScope | "invalid" {
    if (raw === undefined) return undefined;
    const parsed = scopeParam.safeParse(raw);
    if (!parsed.success) return "invalid";
    return parsed.data === "free" ? null : parsed.data;
}

/** The `match_id` condition for a scope, appended to `params`; "" when absent. */
export function matchScopeSql(scope: MatchScope, params: unknown[]): string {
    if (scope === undefined) return "";
    if (scope === null) return " AND match_id IS NULL";
    params.push(scope);
    return ` AND match_id = $${params.length}`;
}
