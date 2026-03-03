import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { findByHash, touchLastUsed, type ApiKeyRow } from "./apiKeyRepo";

const API_KEY_PREFIX = "cpk_";

/** Generate a new raw API key (shown to user once). */
export function generateApiKey(): string {
  const raw = randomBytes(32).toString("hex");
  return `${API_KEY_PREFIX}${raw}`;
}

/** Hash a raw key for storage / lookup. */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Validate a raw API key.
 * Returns the ApiKeyRow if valid, null otherwise.
 * Uses constant-time comparison.
 */
export async function validateApiKey(rawKey: string): Promise<ApiKeyRow | null> {
  const hash = hashApiKey(rawKey);
  const row = await findByHash(hash);
  if (!row) return null;

  // Constant-time comparison of computed hash vs stored hash
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(row.key_hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // Fire-and-forget: update last_used_at
  touchLastUsed(row.id).catch(() => {});

  return row;
}

/** Check if an API key has the required scope. */
export function checkScope(apiKey: ApiKeyRow, requiredScope: string): boolean {
  if (apiKey.scopes.includes("admin")) return true;
  return apiKey.scopes.includes(requiredScope);
}
