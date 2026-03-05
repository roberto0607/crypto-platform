/**
 * txWithEvents — transactional helper with post-commit SSE event publishing.
 *
 * Encapsulates the pattern:
 *   1. Acquire PoolClient, BEGIN
 *   2. Run caller's function (which may push events to pendingEvents)
 *   3. COMMIT
 *   4. Publish SSE events (fire-and-forget, never breaks caller)
 *
 * On error: ROLLBACK, no events published.
 */
import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import { publish } from "../events/eventBus";
import type { AppEvent } from "../events/eventTypes";
import { eventsPublishedTotal } from "../metrics";

export async function txWithEvents<T>(
    fn: (client: PoolClient, pendingEvents: AppEvent[]) => Promise<T>,
): Promise<T> {
    const client = await pool.connect();
    const pendingEvents: AppEvent[] = [];
    let result: T;

    try {
        await client.query("BEGIN");
        result = await fn(client, pendingEvents);
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }

    // After COMMIT: publish SSE events (fire-and-forget)
    for (const event of pendingEvents) {
        try {
            publish(event);
            eventsPublishedTotal.inc({ type: event.type });
        } catch {
            // Events must never break the caller
        }
    }

    return result;
}
