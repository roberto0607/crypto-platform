import { logger } from "../observability/logContext";
import { recordEvent } from "../eventStream/eventService";
import { openIncidentsForQuarantinedUsers } from "../incidents/incidentService";
import { appendRepairEventsIfIncident } from "../incidents/incidentService";
import type { OutboxEventRow } from "./outboxTypes";
import type { EventInput } from "../eventStream/eventTypes";

const MAX_ATTEMPTS = 10;

/**
 * Route an outbox event to its handler.
 * Throws on failure (worker will retry with backoff).
 */
export async function processEvent(event: OutboxEventRow): Promise<void> {
  if (event.attempts >= MAX_ATTEMPTS) {
    logger.warn(
      { outboxId: event.id, event_type: event.event_type, attempts: event.attempts },
      "Outbox event exceeded max attempts — skipping as poison message",
    );
    return;
  }

  switch (event.event_type) {
    case "EVENT_STREAM_APPEND": {
      const input = event.payload.eventInput as EventInput;
      try {
        await recordEvent(input);
      } catch (err: unknown) {
        // Unique violation on event_hash = idempotent success
        if (isUniqueViolation(err)) {
          logger.info(
            { outboxId: event.id, event_type: event.event_type },
            "Outbox EVENT_STREAM_APPEND duplicate — treating as success",
          );
          return;
        }
        throw err;
      }
      break;
    }

    case "INCIDENT_OPEN_BATCH": {
      const { reconRunId, userIds } = event.payload as {
        reconRunId: string;
        userIds: string[];
      };
      await openIncidentsForQuarantinedUsers(reconRunId, userIds);
      break;
    }

    case "REPAIR_EVENT": {
      const { userId, repairRunId, repairEventType, metadata } = event.payload as {
        userId: string;
        repairRunId: string;
        repairEventType: "REPAIR_STARTED" | "REPAIR_APPLIED";
        metadata?: Record<string, unknown>;
      };
      await appendRepairEventsIfIncident(userId, repairRunId, repairEventType, metadata);
      break;
    }

    default:
      logger.warn(
        { outboxId: event.id, event_type: event.event_type },
        "Unknown outbox event_type — marking as processed",
      );
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}
