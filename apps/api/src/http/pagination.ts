/**
 * Cursor-based pagination helpers for /v1 endpoints.
 *
 * Cursor strategy:
 *   - Standard tables (orders, ledger_entries): keyset on (created_at, id)
 *     Cursor payload: { ca: string (ISO), id: string (UUID) }
 *   - equity_snapshots: keyset on ts (unique per user)
 *     Cursor payload: { ts: number }
 *
 * Encoding: base64url(JSON.stringify(payload))
 */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MIN_LIMIT = 1;

// ── Cursor encode / decode ──────────────────────────────

export function encodeCursor(obj: Record<string, unknown>): string {
  const json = JSON.stringify(obj);
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeCursor<T = Record<string, unknown>>(
  cursor: string | undefined,
): T | null {
  if (!cursor) return null;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

// ── Limit parsing ───────────────────────────────────────

export function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(n)));
}

// ── Page slicing helper ─────────────────────────────────

/**
 * Given rows fetched with LIMIT = limit + 1, returns the page
 * and computes nextCursor via the provided cursorBuilder.
 */
export function slicePage<T>(
  rows: T[],
  limit: number,
  buildCursor: (lastRow: T) => Record<string, unknown>,
): { data: T[]; nextCursor: string | null } {
  if (rows.length > limit) {
    const data = rows.slice(0, limit);
    const nextCursor = encodeCursor(buildCursor(data[data.length - 1]));
    return { data, nextCursor };
  }
  return { data: rows, nextCursor: null };
}
