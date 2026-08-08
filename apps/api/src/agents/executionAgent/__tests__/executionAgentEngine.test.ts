/**
 * Execution Agent Engine tests -- verifies the event-subscriber wiring
 * itself (filtering on risk_agent.proposal_approved, gating on the
 * EXECUTION_AGENT_ENABLED flag), not the executor's own decision logic
 * (that's executeTradeProposal.test.ts). eventBus is mocked so the
 * handler can be invoked directly and synchronously inspected.
 *
 * riskEngine.ts (the closest precedent, Gate 1d) has no test file of its
 * own -- this mirrors chartAnalysisEngine.test.ts's structure instead,
 * the only existing coverage of this exact "subscribeGlobal handler,
 * event-type + config-flag gate, fire-and-forget with its own
 * try/catch" shape in this codebase.
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

const mockExecuteTradeProposal = vi.fn();
vi.mock("../executor", () => ({
  executeTradeProposal: (...args: unknown[]) => mockExecuteTradeProposal(...args),
}));

const mockConfig = { executionAgentEnabled: true };
vi.mock("../../../config", () => ({
  get config() {
    return mockConfig;
  },
}));

import { startExecutionAgentEngine, stopExecutionAgentEngine } from "../executionAgentEngine";

const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(async () => {
  capturedHandler = null;
  mockSubscribeGlobal.mockClear();
  mockUnsubscribe.mockClear();
  mockExecuteTradeProposal.mockReset();
  mockExecuteTradeProposal.mockResolvedValue({
    proposalId: PROPOSAL_ID,
    outcome: "executed",
    reason: null,
    orderId: "order-1",
    autoFlattened: false,
  });
  mockConfig.executionAgentEnabled = true;
  await startExecutionAgentEngine();
});

afterEach(() => {
  stopExecutionAgentEngine();
});

// Flush the fire-and-forget async work the handler kicks off.
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("startExecutionAgentEngine", () => {
  it("subscribes exactly one global handler", () => {
    expect(mockSubscribeGlobal).toHaveBeenCalledTimes(1);
  });

  it("is idempotent -- calling start again does not double-subscribe", async () => {
    await startExecutionAgentEngine();
    expect(mockSubscribeGlobal).toHaveBeenCalledTimes(1);
  });

  it("ignores event types other than risk_agent.proposal_approved", async () => {
    capturedHandler!({ type: "chart_analysis.proposal_created", data: { proposalId: PROPOSAL_ID } });
    await flush();
    expect(mockExecuteTradeProposal).not.toHaveBeenCalled();
  });

  it("does nothing when EXECUTION_AGENT_ENABLED is false, even for a matching event", async () => {
    mockConfig.executionAgentEnabled = false;
    capturedHandler!({ type: "risk_agent.proposal_approved", data: { proposalId: PROPOSAL_ID } });
    await flush();
    expect(mockExecuteTradeProposal).not.toHaveBeenCalled();
  });

  it("calls executeTradeProposal with the event's proposalId on a matching event when enabled", async () => {
    capturedHandler!({ type: "risk_agent.proposal_approved", data: { proposalId: PROPOSAL_ID } });
    await flush();

    expect(mockExecuteTradeProposal).toHaveBeenCalledTimes(1);
    expect(mockExecuteTradeProposal).toHaveBeenCalledWith(PROPOSAL_ID);
  });

  it("does not throw and swallows the error when executeTradeProposal rejects unexpectedly (one proposal's failure can't take down the event bus)", async () => {
    // NOTE: the handler itself is synchronous ((event) => void) and can
    // never throw synchronously regardless of whether the async
    // rejection inside is caught -- an expect(() => handler(...)).not.toThrow()
    // assertion would pass even if processApprovedProposal's try/catch
    // were deleted entirely, since the eventual rejection happens on the
    // microtask queue, outside that synchronous call's own stack. The
    // only way to actually prove the rejection is caught internally
    // (not just fire-and-forgotten into a real unhandled rejection) is
    // to listen for process-level "unhandledRejection" directly.
    mockExecuteTradeProposal.mockRejectedValueOnce(new Error("db unreachable"));

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      capturedHandler!({ type: "risk_agent.proposal_approved", data: { proposalId: PROPOSAL_ID } });
      await flush();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(unhandledRejections).toHaveLength(0);
    expect(mockExecuteTradeProposal).toHaveBeenCalledTimes(1);
  });
});

describe("stopExecutionAgentEngine", () => {
  it("unsubscribes the handler", () => {
    stopExecutionAgentEngine();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
