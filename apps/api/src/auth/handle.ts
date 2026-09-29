/**
 * handle.ts — the public handle (users.display_name): one format rule and one
 * availability check, shared by signup, profile edits, and the landing page.
 */

import { z } from "zod";
import { pool } from "../db/pool";

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 30;

export const handleSchema = z.string()
    .min(HANDLE_MIN, `Display name must be at least ${HANDLE_MIN} characters`)
    .max(HANDLE_MAX, `Display name must be at most ${HANDLE_MAX} characters`)
    .regex(/^[a-zA-Z0-9_]+$/, "Display name can only contain letters, numbers, and underscores");

/** Unique index backing handle uniqueness (migration 093). */
export const HANDLE_UNIQUE_CONSTRAINT = "users_display_name_lower_unique";

export type HandleAvailability =
    | { available: true }
    | { available: false; reason: "invalid" | "taken" };

export async function checkHandleAvailability(handle: string): Promise<HandleAvailability> {
    if (!handleSchema.safeParse(handle).success) return { available: false, reason: "invalid" };
    const { rowCount } = await pool.query(
        `SELECT 1 FROM users WHERE lower(display_name) = lower($1) LIMIT 1`,
        [handle],
    );
    return rowCount ? { available: false, reason: "taken" } : { available: true };
}
