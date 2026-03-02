import { createHash } from "node:crypto";

/**
 * Recursively produce a canonical JSON string with sorted keys at every level.
 * Guarantees deterministic output regardless of insertion order.
 */
export function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";

  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalJsonStringify).join(",") + "]";
  }

  if (obj instanceof Date) return JSON.stringify(obj);

  if (typeof obj === "object") {
    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const pairs = keys.map(
      (k) => JSON.stringify(k) + ":" + canonicalJsonStringify(record[k]),
    );
    return "{" + pairs.join(",") + "}";
  }

  return JSON.stringify(obj);
}

/**
 * Compute SHA-256 hex hash over the canonical event fields.
 */
export function computeEventHash(input: {
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  actor_user_id: string | null;
  payload: Record<string, unknown>;
  previous_event_hash: string;
  created_at_iso: string;
}): string {
  const canonical = canonicalJsonStringify({
    actor_user_id: input.actor_user_id,
    created_at_iso: input.created_at_iso,
    entity_id: input.entity_id,
    entity_type: input.entity_type,
    event_type: input.event_type,
    payload: input.payload,
    previous_event_hash: input.previous_event_hash,
  });

  return createHash("sha256").update(canonical).digest("hex");
}
