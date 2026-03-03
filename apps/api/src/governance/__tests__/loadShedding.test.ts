import { describe, it, expect } from "vitest";
import type { LoadState } from "../loadState";
import { evaluateRequestPolicy, PolicyDecision } from "../loadShedding";
import { Priority } from "../priorityClasses";

// ── Helpers ──

function normalState(): LoadState {
  return {
    dbPoolWaitingCount: 0,
    outboxQueueDepth: 0,
    lockWaitCount: 0,
    inflightRequests: 0,
    isDbSaturated: false,
    isOutboxBackedUp: false,
    isHighLockContention: false,
    isOverloaded: false,
  };
}

function dbSaturatedState(): LoadState {
  return {
    ...normalState(),
    dbPoolWaitingCount: 25,
    isDbSaturated: true,
    isOverloaded: true,
  };
}

function outboxBacklogState(): LoadState {
  return {
    ...normalState(),
    outboxQueueDepth: 1500,
    isOutboxBackedUp: true,
    isOverloaded: true,
  };
}

function lockContentionState(): LoadState {
  return {
    ...normalState(),
    lockWaitCount: 15,
    isHighLockContention: true,
    isOverloaded: true,
  };
}

function inflightOverflowState(): LoadState {
  return {
    ...normalState(),
    inflightRequests: 600,
    isOverloaded: true,
  };
}

// ── Tests ──

describe("evaluateRequestPolicy", () => {
  describe("normal load — all requests allowed", () => {
    it("allows CRITICAL POST", () => {
      const result = evaluateRequestPolicy("POST", Priority.CRITICAL, normalState());
      expect(result.decision).toBe(PolicyDecision.ALLOW);
    });

    it("allows IMPORTANT GET", () => {
      const result = evaluateRequestPolicy("GET", Priority.IMPORTANT, normalState());
      expect(result.decision).toBe(PolicyDecision.ALLOW);
    });

    it("allows LOW GET", () => {
      const result = evaluateRequestPolicy("GET", Priority.LOW, normalState());
      expect(result.decision).toBe(PolicyDecision.ALLOW);
    });
  });

  describe("DB saturated", () => {
    it("CRITICAL always allowed", () => {
      const result = evaluateRequestPolicy("POST", Priority.CRITICAL, dbSaturatedState());
      expect(result.decision).toBe(PolicyDecision.ALLOW);
    });

    it("IMPORTANT GET allowed (read-only)", () => {
      const result = evaluateRequestPolicy("GET", Priority.IMPORTANT, dbSaturatedState());
      expect(result.decision).toBe(PolicyDecision.ALLOW);
    });

    it("IMPORTANT POST rejected", () => {
      const result = evaluateRequestPolicy("POST", Priority.IMPORTANT, dbSaturatedState());
      expect(result.decision).toBe(PolicyDecision.REJECT_TEMPORARILY);
      expect(result.reason).toBe("DB_SATURATED");
    });

    it("LOW rejected", () => {
      const result = evaluateRequestPolicy("GET", Priority.LOW, dbSaturatedState());
      expect(result.decision).toBe(PolicyDecision.REJECT_TEMPORARILY);
      expect(result.reason).toBe("DB_SATURATED");
    });
  });

  describe("outbox backlog", () => {
    it("LOW rejected", () => {
      const result = evaluateRequestPolicy("GET", Priority.LOW, outboxBacklogState());
      expect(result.decision).toBe(PolicyDecision.REJECT_TEMPORARILY);
      expect(result.reason).toBe("OUTBOX_BACKLOG");
    });

    it("IMPORTANT allowed", () => {
      const result = evaluateRequestPolicy("GET", Priority.IMPORTANT, outboxBacklogState());
      expect(result.decision).toBe(PolicyDecision.ALLOW);
    });

    it("CRITICAL allowed", () => {
      const result = evaluateRequestPolicy("POST", Priority.CRITICAL, outboxBacklogState());
      expect(result.decision).toBe(PolicyDecision.ALLOW);
    });
  });

  describe("lock contention", () => {
    it("LOW rejected", () => {
      const result = evaluateRequestPolicy("POST", Priority.LOW, lockContentionState());
      expect(result.decision).toBe(PolicyDecision.REJECT_TEMPORARILY);
      expect(result.reason).toBe("LOCK_CONTENTION");
    });

    it("IMPORTANT allowed", () => {
      const result = evaluateRequestPolicy("POST", Priority.IMPORTANT, lockContentionState());
      expect(result.decision).toBe(PolicyDecision.ALLOW);
    });
  });

  describe("inflight overflow", () => {
    it("LOW rejected", () => {
      const result = evaluateRequestPolicy("GET", Priority.LOW, inflightOverflowState());
      expect(result.decision).toBe(PolicyDecision.REJECT_TEMPORARILY);
      expect(result.reason).toBe("INFLIGHT_OVERFLOW");
    });

    it("IMPORTANT allowed", () => {
      const result = evaluateRequestPolicy("GET", Priority.IMPORTANT, inflightOverflowState());
      expect(result.decision).toBe(PolicyDecision.ALLOW);
    });

    it("CRITICAL allowed", () => {
      const result = evaluateRequestPolicy("POST", Priority.CRITICAL, inflightOverflowState());
      expect(result.decision).toBe(PolicyDecision.ALLOW);
    });
  });

  describe("503 response shape", () => {
    it("includes reason on rejection", () => {
      const result = evaluateRequestPolicy("GET", Priority.LOW, dbSaturatedState());
      expect(result).toEqual({
        decision: PolicyDecision.REJECT_TEMPORARILY,
        reason: "DB_SATURATED",
      });
    });

    it("no reason on allow", () => {
      const result = evaluateRequestPolicy("POST", Priority.CRITICAL, dbSaturatedState());
      expect(result).toEqual({ decision: PolicyDecision.ALLOW });
    });
  });
});
