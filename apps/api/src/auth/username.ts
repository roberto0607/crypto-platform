import { z } from "zod";

/** The unique index on lower(display_name), migration 103. */
export const USERNAME_UNIQUE_INDEX = "users_display_name_lower_uq";

/**
 * Names nobody can take, compared in lower case: staff impersonation, the bots,
 * and words the UI prints in place of a name ("YOU", "OPPONENT", "Anonymous").
 * Migration 103 repeats this list; keep the two in step.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
    "admin", "administrator", "anonymous", "api", "bot", "challenger",
    "demo", "help", "market_maker", "marketmaker", "mmbot", "mod",
    "moderator", "null", "official", "opponent", "playtradr", "risk_agent",
    "riskagent", "root", "staff", "support", "system", "trader", "tradr",
    "undefined", "unknown", "you",
]);

export const usernameSchema = z.string()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must be at most 30 characters")
    .regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores");

export function isReservedUsername(username: string): boolean {
    return RESERVED_USERNAMES.has(username.toLowerCase());
}

export function isUsernameConflict(err: unknown): boolean {
    const pgError = err as { code?: string; constraint?: string } | null;
    return pgError?.code === "23505" && pgError.constraint === USERNAME_UNIQUE_INDEX;
}
