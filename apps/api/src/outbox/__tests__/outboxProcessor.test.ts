import { describe, it, expect, vi, beforeEach } from "vitest";

/* ── Mocks ────────────────────────────────────────────────── */

vi.mock("../../eventStream/eventService", () => ({
  recordEvent: vi.fn(),
}));

vi.mock("../../incidents/incidentService", () => ({
  openIncidentsForQuarantinedUsers: vi.fn(),
  appendRepairEventsIfIncident: vi.fn(),
}));

// Canonical logger mock — factory scoped inside vi.mock closure because
// vi.mock is hoisted to the top of the file. See phase6OrderService.test.ts.
vi.mock("../../observability/logContext", () => {
  const makeMockLogger = () => {
    const l: any = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => makeMockLogger()),
    };
    return l;
  };
  return {
    logger: makeMockLogger(),
  };
});

import { processEvent } from "../outboxProcessor";
import { recordEvent } from "../../eventStream/eventService";
import { openIncidentsForQuarantinedUsers, appendRepairEventsIfIncident } from "../../incidents/incidentService";
import { logger } from "../../observability/logContext";
import type { OutboxEventRow } from "../outboxTypes";

/* ── Helpers ──────────────────────────────────────────────── */

function makeEvent(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    id: "evt-1",
    event_type: "EVENT_STREAM_APPEND",
    aggregate_type: "ORDER",
    aggregate_id: null,
    payload: {},
    status: "PROCESSING",
    attempts: 0,
    last_error: null,
    next_attempt_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    processed_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ════════════════════════════════════════════════════════════
   EVENT_STREAM_APPEND
   ════════════════════════════════════════════════════════════ */

describe("EVENT_STREAM_APPEND", () => {
  it("calls recordEvent with correct event data", async () => {
    const eventInput = { type: "ORDER_PLACED", aggregateId: "o1", data: { side: "BUY" } };
    const event = makeEvent({
      event_type: "EVENT_STREAM_APPEND",
      payload: { eventInput },
    });

    await processEvent(event);

    expect(recordEvent).toHaveBeenCalledWith(eventInput);
  });

  it("handles duplicate (unique violation 23505) gracefully — no throw", async () => {
    const err = new Error("duplicate key") as Error & { code: string };
    err.code = "23505";
    vi.mocked(recordEvent).mockRejectedValueOnce(err);

    const event = makeEvent({
      event_type: "EVENT_STREAM_APPEND",
      payload: { eventInput: { type: "X" } },
    });

    await expect(processEvent(event)).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ outboxId: event.id }),
      expect.stringContaining("duplicate"),
    );
  });

  it("rethrows non-unique-violation database errors", async () => {
    const err = new Error("connection error") as Error & { code: string };
    err.code = "ECONNREFUSED";
    vi.mocked(recordEvent).mockRejectedValueOnce(err);

    const event = makeEvent({
      event_type: "EVENT_STREAM_APPEND",
      payload: { eventInput: { type: "X" } },
    });

    await expect(processEvent(event)).rejects.toThrow("connection error");
  });
});

/* ════════════════════════════════════════════════════════════
   INCIDENT_OPEN_BATCH
   ════════════════════════════════════════════════════════════ */

describe("INCIDENT_OPEN_BATCH", () => {
  it("calls openIncidentsForQuarantinedUsers with reconRunId and userIds", async () => {
    const event = makeEvent({
      event_type: "INCIDENT_OPEN_BATCH",
      payload: { reconRunId: "recon-1", userIds: ["u1", "u2"] },
    });

    await processEvent(event);

    expect(openIncidentsForQuarantinedUsers).toHaveBeenCalledWith("recon-1", ["u1", "u2"]);
  });

  it("handles empty userIds array without error", async () => {
    const event = makeEvent({
      event_type: "INCIDENT_OPEN_BATCH",
      payload: { reconRunId: "recon-2", userIds: [] },
    });

    await expect(processEvent(event)).resolves.toBeUndefined();
    expect(openIncidentsForQuarantinedUsers).toHaveBeenCalledWith("recon-2", []);
  });

  it("propagates errors from incidentService", async () => {
    vi.mocked(openIncidentsForQuarantinedUsers).mockRejectedValueOnce(new Error("db down"));

    const event = makeEvent({
      event_type: "INCIDENT_OPEN_BATCH",
      payload: { reconRunId: "r1", userIds: ["u1"] },
    });

    await expect(processEvent(event)).rejects.toThrow("db down");
  });
});

/* ════════════════════════════════════════════════════════════
   REPAIR_EVENT
   ════════════════════════════════════════════════════════════ */

describe("REPAIR_EVENT", () => {
  it("routes REPAIR_STARTED to appendRepairEventsIfIncident", async () => {
    const event = makeEvent({
      event_type: "REPAIR_EVENT",
      payload: {
        userId: "u1",
        repairRunId: "rr-1",
        repairEventType: "REPAIR_STARTED",
        metadata: { source: "auto" },
      },
    });

    await processEvent(event);

    expect(appendRepairEventsIfIncident).toHaveBeenCalledWith(
      "u1", "rr-1", "REPAIR_STARTED", { source: "auto" },
    );
  });

  it("routes REPAIR_APPLIED to appendRepairEventsIfIncident", async () => {
    const event = makeEvent({
      event_type: "REPAIR_EVENT",
      payload: {
        userId: "u2",
        repairRunId: "rr-2",
        repairEventType: "REPAIR_APPLIED",
      },
    });

    await processEvent(event);

    expect(appendRepairEventsIfIncident).toHaveBeenCalledWith(
      "u2", "rr-2", "REPAIR_APPLIED", undefined,
    );
  });
});

/* ════════════════════════════════════════════════════════════
   Error handling / edge cases
   ════════════════════════════════════════════════════════════ */

describe("error handling", () => {
  it("unknown event type logs warning and returns (no throw)", async () => {
    const event = makeEvent({ event_type: "UNKNOWN_TYPE" });

    await expect(processEvent(event)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "UNKNOWN_TYPE" }),
      expect.stringContaining("Unknown outbox event_type"),
    );
  });

  it("poison message (attempts >= 10) is skipped with warning", async () => {
    const event = makeEvent({
      event_type: "EVENT_STREAM_APPEND",
      attempts: 10,
      payload: { eventInput: { type: "X" } },
    });

    await expect(processEvent(event)).resolves.toBeUndefined();
    expect(recordEvent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 10 }),
      expect.stringContaining("poison message"),
    );
  });

  it("errors from handlers propagate to caller for retry", async () => {
    vi.mocked(recordEvent).mockRejectedValueOnce(new Error("timeout"));

    const event = makeEvent({
      event_type: "EVENT_STREAM_APPEND",
      payload: { eventInput: { type: "X" } },
    });

    await expect(processEvent(event)).rejects.toThrow("timeout");
  });
});
