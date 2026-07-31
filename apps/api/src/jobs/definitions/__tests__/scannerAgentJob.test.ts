/**
 * scannerAgentJob.test.ts — unit tests for the job wrapper around
 * runScannerAgent (Gate 1b Task 5). Mocked like runner.test.ts (no real
 * Anthropic/DB/Redis calls) -- this file only tests the wrapper's own
 * logic: the enabled/disabled gate, and the publish-on-success /
 * no-publish-on-failure branching. Model quality and the tool-use loop
 * itself are covered by runner.test.ts.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { JobContext } from "../../jobTypes";

const mockRunScannerAgent = vi.fn();
vi.mock("../../../agents/scanner/runner", () => ({
  runScannerAgent: (...args: unknown[]) => mockRunScannerAgent(...args),
}));

const mockPublish = vi.fn();
vi.mock("../../../events/eventBus", () => ({
  publish: (...args: unknown[]) => mockPublish(...args),
}));

const mockConfig = vi.hoisted(() => ({
  scannerAgentEnabled: true,
  scannerAgentIntervalSeconds: 1800,
}));
vi.mock("../../../config", () => ({
  config: mockConfig,
}));

import { scannerAgentJob } from "../scannerAgentJob";

function fakeCtx(): JobContext {
  return {
    pool: {} as JobContext["pool"],
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as JobContext["logger"],
    signal: new AbortController().signal,
  };
}

describe("scannerAgentJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.scannerAgentEnabled = true;
  });

  it("no-ops without calling runScannerAgent when disabled", async () => {
    mockConfig.scannerAgentEnabled = false;

    await scannerAgentJob.run(fakeCtx());

    expect(mockRunScannerAgent).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("publishes a scanner.result event when the run produces a result", async () => {
    const candidates = [
      { pairId: "p1", symbol: "BTC/USD", rank: 1, reasoning: "test", supportingDataPoints: [] },
    ];
    mockRunScannerAgent.mockResolvedValue({
      result: { candidates },
      error: null,
      latencyMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.0001,
    });

    await scannerAgentJob.run(fakeCtx());

    expect(mockRunScannerAgent).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const published = mockPublish.mock.calls[0][0];
    expect(published.type).toBe("scanner.result");
    expect(published.data.candidates).toEqual(candidates);
  });

  it("does not publish when the run has no result (error/parse-failure path)", async () => {
    mockRunScannerAgent.mockResolvedValue({
      result: null,
      error: "Model output failed scannerResult schema validation",
      latencyMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.0001,
    });

    await scannerAgentJob.run(fakeCtx());

    expect(mockRunScannerAgent).toHaveBeenCalledTimes(1);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("does not throw when publish itself fails", async () => {
    mockRunScannerAgent.mockResolvedValue({
      result: { candidates: [] },
      error: null,
      latencyMs: 100,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    mockPublish.mockImplementation(() => {
      throw new Error("redis unreachable");
    });

    await expect(scannerAgentJob.run(fakeCtx())).resolves.not.toThrow();
  });
});
