/**
 * Chart Analysis Engine tests — verifies the event-subscriber wiring
 * itself (filtering on scanner.result, gating on the
 * CHART_ANALYSIS_AGENT_ENABLED flag, running once per candidate), not the
 * agent's reasoning (that's runner.test.ts). eventBus is mocked so the
 * handler can be invoked directly and synchronously inspected.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

let capturedHandler: ((event: unknown) => void) | null = null;
const mockSubscribeGlobal = vi.fn((handler: (event: unknown) => void) => {
  capturedHandler = handler;
});
const mockUnsubscribe = vi.fn();
vi.mock("../../../events/eventBus", () => ({
  subscribeGlobal: (...args: [(event: unknown) => void]) => mockSubscribeGlobal(...args),
  unsubscribe: (...args: unknown[]) => mockUnsubscribe(...args),
}));

vi.mock("../../../observability/logContext", () => {
  const makeMockLogger = (): Record<string, unknown> => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => makeMockLogger()),
  });
  return { logger: makeMockLogger() };
});

const mockRunChartAnalysisAgent = vi.fn();
vi.mock("../runner", () => ({
  runChartAnalysisAgent: (...args: unknown[]) => mockRunChartAnalysisAgent(...args),
}));

const mockConfig = { chartAnalysisAgentEnabled: true };
vi.mock("../../../config", () => ({
  get config() {
    return mockConfig;
  },
}));

import { startChartAnalysisEngine, stopChartAnalysisEngine } from "../chartAnalysisEngine";

const CANDIDATES = [
  { pairId: "p1", symbol: "SOL/USD", rank: 1, reasoning: "r1", supportingDataPoints: [] },
  { pairId: "p2", symbol: "ETH/USD", rank: 2, reasoning: "r2", supportingDataPoints: [] },
];

beforeEach(async () => {
  capturedHandler = null;
  mockSubscribeGlobal.mockClear();
  mockUnsubscribe.mockClear();
  mockRunChartAnalysisAgent.mockReset();
  mockRunChartAnalysisAgent.mockResolvedValue({ proposalId: "proposal-1", error: null, latencyMs: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 });
  mockConfig.chartAnalysisAgentEnabled = true;
  await startChartAnalysisEngine();
});

afterEach(() => {
  stopChartAnalysisEngine();
});

// Flush the fire-and-forget async work the handler kicks off.
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("startChartAnalysisEngine", () => {
  it("subscribes exactly one global handler", () => {
    expect(mockSubscribeGlobal).toHaveBeenCalledTimes(1);
  });

  it("is idempotent -- calling start again does not double-subscribe", async () => {
    await startChartAnalysisEngine();
    expect(mockSubscribeGlobal).toHaveBeenCalledTimes(1);
  });

  it("ignores event types other than scanner.result", async () => {
    capturedHandler!({ type: "price.tick", data: {} });
    await flush();
    expect(mockRunChartAnalysisAgent).not.toHaveBeenCalled();
  });

  it("runs the Chart Analysis Agent once per candidate on scanner.result, in order", async () => {
    capturedHandler!({ type: "scanner.result", data: { candidates: CANDIDATES } });
    await flush();

    expect(mockRunChartAnalysisAgent).toHaveBeenCalledTimes(2);
    expect(mockRunChartAnalysisAgent).toHaveBeenNthCalledWith(1, CANDIDATES[0]);
    expect(mockRunChartAnalysisAgent).toHaveBeenNthCalledWith(2, CANDIDATES[1]);
  });

  it("does nothing when CHART_ANALYSIS_AGENT_ENABLED is false", async () => {
    mockConfig.chartAnalysisAgentEnabled = false;
    capturedHandler!({ type: "scanner.result", data: { candidates: CANDIDATES } });
    await flush();
    expect(mockRunChartAnalysisAgent).not.toHaveBeenCalled();
  });

  it("continues to the next candidate when one candidate's run rejects unexpectedly", async () => {
    mockRunChartAnalysisAgent
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ proposalId: "proposal-2", error: null, latencyMs: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 });

    capturedHandler!({ type: "scanner.result", data: { candidates: CANDIDATES } });
    await flush();

    expect(mockRunChartAnalysisAgent).toHaveBeenCalledTimes(2);
  });
});

describe("stopChartAnalysisEngine", () => {
  it("unsubscribes the handler", () => {
    stopChartAnalysisEngine();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
