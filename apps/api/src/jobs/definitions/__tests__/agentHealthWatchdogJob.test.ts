/**
 * agentHealthWatchdogJob.test.ts -- unit tests for the agent-health
 * watchdog job (job-observability fix, 2026-08-11). ctx.pool/ctx.logger
 * are plain injected mocks, no real DB (same pattern as
 * executionAgentRecoveryJob.test.ts/scannerAgentJob.test.ts). config is
 * mocked via vi.hoisted so individual tests can flip
 * scannerAgentEnabled/chartAnalysisAgentEnabled per case. Fake timers
 * pin "now" so minutesSinceLastSuccess can be asserted as an exact
 * value rather than a loose range.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { JobContext } from "../../jobTypes";

const mockConfig = vi.hoisted(() => ({
  scannerAgentEnabled: true,
  chartAnalysisAgentEnabled: true,
}));
vi.mock("../../../config", () => ({ config: mockConfig }));

import { agentHealthWatchdogJob } from "../agentHealthWatchdogJob";

const NOW = new Date("2026-08-11T12:00:00.000Z").getTime();

const mockQuery = vi.fn();
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function fakeCtx(): JobContext {
  return {
    pool: { query: mockQuery } as unknown as JobContext["pool"],
    logger: mockLogger as unknown as JobContext["logger"],
    signal: new AbortController().signal,
  };
}

/** Shape returned by the job's SELECT -- either one row or none. */
function successRow(createdAt: Date | null) {
  return { rows: createdAt ? [{ created_at: createdAt }] : [] };
}

function minutesAgo(mins: number): Date {
  return new Date(NOW - mins * 60_000);
}

describe("agentHealthWatchdogJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockConfig.scannerAgentEnabled = true;
    mockConfig.chartAnalysisAgentEnabled = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs nothing when both agents have a recent success", async () => {
    mockQuery.mockResolvedValue(successRow(minutesAgo(5)));

    await agentHealthWatchdogJob.run(fakeCtx());

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("logs agent_health_watchdog_unhealthy when the last success is older than 90 minutes", async () => {
    mockQuery.mockResolvedValue(successRow(minutesAgo(91)));

    await agentHealthWatchdogJob.run(fakeCtx());

    expect(mockLogger.error).toHaveBeenCalledTimes(2);
    for (const agentName of ["scanner", "chart-analysis"]) {
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName,
          lastSuccessAt: minutesAgo(91).toISOString(),
          minutesSinceLastSuccess: 91,
        }),
        "agent_health_watchdog_unhealthy",
      );
    }
  });

  it("logs with lastSuccessAt: null and minutesSinceLastSuccess: null when the agent has never succeeded", async () => {
    mockQuery.mockResolvedValue(successRow(null));

    await agentHealthWatchdogJob.run(fakeCtx());

    expect(mockLogger.error).toHaveBeenCalledTimes(2);
    for (const agentName of ["scanner", "chart-analysis"]) {
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName,
          lastSuccessAt: null,
          minutesSinceLastSuccess: null,
        }),
        "agent_health_watchdog_unhealthy",
      );
    }
  });

  it("skips the query entirely for a disabled agent, and does not log", async () => {
    mockConfig.scannerAgentEnabled = false;
    mockQuery.mockResolvedValue(successRow(minutesAgo(5))); // chart-analysis: healthy

    await agentHealthWatchdogJob.run(fakeCtx());

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0]![1]).toEqual(["chart-analysis"]);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("checks agents independently: one healthy, one unhealthy -- only the unhealthy one logs, both get queried", async () => {
    mockQuery.mockImplementation((_sql: string, params: [string]) => {
      const [agentName] = params;
      if (agentName === "scanner") return Promise.resolve(successRow(minutesAgo(5))); // healthy
      return Promise.resolve(successRow(minutesAgo(120))); // chart-analysis: unhealthy
    });

    await agentHealthWatchdogJob.run(fakeCtx());

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ["scanner"]);
    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ["chart-analysis"]);

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "chart-analysis",
        lastSuccessAt: minutesAgo(120).toISOString(),
        minutesSinceLastSuccess: 120,
      }),
      "agent_health_watchdog_unhealthy",
    );
  });
});
