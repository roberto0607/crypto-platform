/**
 * executionAgentRecoveryJob.test.ts — unit tests for the Execution Agent
 * crash-recovery job. registerProtectionOrFlatten and
 * ensureRiskAgentBotSetup mocked at their module boundaries (same
 * convention as executeTradeProposal.test.ts) -- this file does NOT
 * re-test registerProtectionOrFlatten's own retry/OCO/auto-flatten
 * logic, that's executeTradeProposal.test.ts's job. This file only
 * tests: the query's literal SQL shape, how the job reacts to each of
 * the 5 hand-verified detection-query row shapes, the null-guard before
 * reconstructing an ApprovedProposal, the origin="recovery" escalation
 * path, per-row error isolation (including accurate final counters, not
 * just "didn't throw"), and the summary-log gating convention shared
 * with matchCleanupJob.
 *
 * ctx.pool/ctx.logger are plain injected objects, not module mocks --
 * run(ctx) takes them as parameters rather than importing pool/logger
 * directly (same pattern as scannerAgentJob.test.ts's fakeCtx()).
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { JobContext } from "../../jobTypes";

const mockRegisterProtectionOrFlatten = vi.fn();
vi.mock("../../../agents/executionAgent/executor", () => ({
  registerProtectionOrFlatten: (...args: unknown[]) => mockRegisterProtectionOrFlatten(...args),
}));

const mockEnsureRiskAgentBotSetup = vi.fn();
vi.mock("../../../agents/riskAgent/botSetup", () => ({
  ensureRiskAgentBotSetup: (...args: unknown[]) => mockEnsureRiskAgentBotSetup(...args),
}));

vi.mock("../../../config", () => ({
  config: { riskAgentBotUserId: "bot-user-id" },
}));

import { executionAgentRecoveryJob } from "../executionAgentRecoveryJob";

const PROPOSAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAIR_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORDER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const mockQuery = vi.fn();
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function fakeCtx(): JobContext {
  return {
    pool: { query: mockQuery } as unknown as JobContext["pool"],
    logger: mockLogger as unknown as JobContext["logger"],
    signal: new AbortController().signal,
  };
}

/** Shape returned by the job's SELECT -- all string columns, matching the real (nullable) DB types. */
function candidateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: PROPOSAL_ID,
    pair_id: PAIR_ID,
    side: "BUY",
    entry_price: "50000.00000000",
    stop_price: "45000.00000000",
    target_price: "55000.00000000",
    qty: "0.20000000",
    stop_distance_pct: "0.1",
    executed_order_id: ORDER_ID,
    ...overrides,
  };
}

function successResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    proposalId: PROPOSAL_ID,
    outcome: "executed",
    reason: null,
    orderId: ORDER_ID,
    autoFlattened: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureRiskAgentBotSetup.mockResolvedValue(undefined);
});

describe("executionAgentRecoveryJob — query shape sanity", () => {
  it("issues a SELECT against trade_proposals with outcome='executed', flatten_order_id IS NULL, the DISTINCT-kind-count-under-2 subquery against trigger_orders, and LIMIT 50", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await executionAgentRecoveryJob.run(fakeCtx());

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0]!;
    expect(typeof sql).toBe("string");
    expect(sql).toContain("FROM trade_proposals tp");
    expect(sql).toContain("outcome = 'executed'");
    expect(sql).toContain("flatten_order_id IS NULL");
    expect(sql).toContain("COUNT(DISTINCT t.kind)");
    expect(sql).toContain("FROM trigger_orders t");
    expect(sql).toContain("t.trade_proposal_id = tp.id");
    expect(sql).toContain("t.kind IN ('STOP_MARKET', 'TAKE_PROFIT_MARKET')");
    // Literal status list -- must catch someone loosening this (e.g.
    // adding 'FAILED'/'EXPIRED' or dropping 'CANCELED', either of which
    // would misclassify a normal OCO fire or a resolved auto-flatten).
    expect(sql).toContain("t.status IN ('ACTIVE', 'TRIGGERED', 'CANCELED')");
    expect(sql).toContain(") < 2");
    // Literal LIMIT -- must catch someone dropping the cap entirely.
    expect(sql).toContain("LIMIT 50");
  });
});

describe("executionAgentRecoveryJob — case: healthy pair somehow present in query results (defensive)", () => {
  it("does not silently skip a row the query returned -- still calls registerProtectionOrFlatten with origin='recovery'; the job trusts the SQL's filtering and applies no redundant re-check of trigger completeness in JS", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidateRow()] });
    mockRegisterProtectionOrFlatten.mockResolvedValueOnce(successResult());

    await executionAgentRecoveryJob.run(fakeCtx());

    expect(mockRegisterProtectionOrFlatten).toHaveBeenCalledTimes(1);
  });
});

describe("executionAgentRecoveryJob — case: crashed-before-Phase-2 row (0 trigger_orders)", () => {
  it("reconstructs an ApprovedProposal from the row and calls registerProtectionOrFlatten(proposal, row.executed_order_id, botUserId, 'recovery') with the exact expected args; increments recovered on a non-'recovery_also_failed' result", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidateRow()] });
    mockRegisterProtectionOrFlatten.mockResolvedValueOnce(successResult({ reason: null }));

    await executionAgentRecoveryJob.run(fakeCtx());

    expect(mockRegisterProtectionOrFlatten).toHaveBeenCalledWith(
      {
        id: PROPOSAL_ID,
        pair_id: PAIR_ID,
        side: "BUY",
        entry_price: "50000.00000000",
        stop_price: "45000.00000000",
        target_price: "55000.00000000",
        qty: "0.20000000",
        stop_distance_pct: "0.1",
      },
      ORDER_ID,
      "bot-user-id",
      "recovery",
    );

    expect(mockLogger.info).toHaveBeenCalledWith(
      { candidates: 1, recovered: 1, stillFailed: 0, skipped: 0 },
      "execution_agent_recovery_done",
    );
  });
});

describe("executionAgentRecoveryJob — case: partial-registration row (1 leg only)", () => {
  it("calls registerProtectionOrFlatten the same way as the 0-trigger case and increments recovered on success -- this exercises the identical job-level code path as the crashed-before-Phase-2 case (the row only carries trade_proposals columns, not trigger_orders state); kept as a separate test only to trace back to the 5 hand-verified detection-query cases, not because the job itself branches on WHY a row was flagged. Uses reason:'auto_flattened' (vs. the previous case's reason:null) to also confirm BOTH successful outcomes of registerProtectionOrFlatten count as recovered.", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidateRow()] });
    mockRegisterProtectionOrFlatten.mockResolvedValueOnce(
      successResult({ reason: "auto_flattened", autoFlattened: true }),
    );

    await executionAgentRecoveryJob.run(fakeCtx());

    expect(mockRegisterProtectionOrFlatten).toHaveBeenCalledWith(
      expect.objectContaining({ id: PROPOSAL_ID }),
      ORDER_ID,
      "bot-user-id",
      "recovery",
    );

    expect(mockLogger.info).toHaveBeenCalledWith(
      { candidates: 1, recovered: 1, stillFailed: 0, skipped: 0 },
      "execution_agent_recovery_done",
    );
  });
});

describe("executionAgentRecoveryJob — null-guard before reconstructing ApprovedProposal", () => {
  it("qty === null: increments skipped (not stillFailed or recovered), logs execution_agent_recovery_row_missing_fields with the proposalId, never calls registerProtectionOrFlatten", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidateRow({ qty: null })] });

    await executionAgentRecoveryJob.run(fakeCtx());

    expect(mockRegisterProtectionOrFlatten).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { proposalId: PROPOSAL_ID },
      "execution_agent_recovery_row_missing_fields",
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      { candidates: 1, recovered: 0, stillFailed: 0, skipped: 1 },
      "execution_agent_recovery_done",
    );
  });

  it("stop_distance_pct === null: same skip/log/no-call behavior", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidateRow({ stop_distance_pct: null })] });

    await executionAgentRecoveryJob.run(fakeCtx());

    expect(mockRegisterProtectionOrFlatten).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { proposalId: PROPOSAL_ID },
      "execution_agent_recovery_row_missing_fields",
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      { candidates: 1, recovered: 0, stillFailed: 0, skipped: 1 },
      "execution_agent_recovery_done",
    );
  });

  it("executed_order_id === null: same skip/log/no-call behavior", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidateRow({ executed_order_id: null })] });

    await executionAgentRecoveryJob.run(fakeCtx());

    expect(mockRegisterProtectionOrFlatten).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { proposalId: PROPOSAL_ID },
      "execution_agent_recovery_row_missing_fields",
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      { candidates: 1, recovered: 0, stillFailed: 0, skipped: 1 },
      "execution_agent_recovery_done",
    );
  });
});

describe("executionAgentRecoveryJob — escalation path: origin='recovery' retry also fails", () => {
  it("registerProtectionOrFlatten resolving reason:'recovery_also_failed' increments stillFailed, not recovered -- asserted against the literal reason value, not inferred from 'anything other than success'", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidateRow()] });
    mockRegisterProtectionOrFlatten.mockResolvedValueOnce(
      successResult({ reason: "recovery_also_failed", autoFlattened: true }),
    );

    await executionAgentRecoveryJob.run(fakeCtx());

    expect(mockLogger.info).toHaveBeenCalledWith(
      { candidates: 1, recovered: 0, stillFailed: 1, skipped: 0 },
      "execution_agent_recovery_done",
    );
  });
});

describe("executionAgentRecoveryJob — error isolation across a batch", () => {
  it("registerProtectionOrFlatten throwing for row 1 of 2 does not stop row 2 from being processed: row 2's call still happens, the FINAL COUNTS are stillFailed=1 and recovered=1 (not just 'no exception propagated'), and execution_agent_recovery_row_failed logs with row 1's proposalId", async () => {
    const PROPOSAL_ID_1 = "11111111-1111-4111-8111-111111111111";
    const PROPOSAL_ID_2 = "22222222-2222-4222-8222-222222222222";
    const ORDER_ID_1 = "33333333-3333-4333-8333-333333333333";
    const ORDER_ID_2 = "44444444-4444-4444-8444-444444444444";

    const row1 = candidateRow({ id: PROPOSAL_ID_1, executed_order_id: ORDER_ID_1 });
    const row2 = candidateRow({ id: PROPOSAL_ID_2, executed_order_id: ORDER_ID_2 });
    mockQuery.mockResolvedValueOnce({ rows: [row1, row2] });

    const thrown = new Error("db_connection_lost");
    mockRegisterProtectionOrFlatten
      .mockRejectedValueOnce(thrown)
      .mockResolvedValueOnce(successResult({ proposalId: PROPOSAL_ID_2, orderId: ORDER_ID_2 }));

    await expect(executionAgentRecoveryJob.run(fakeCtx())).resolves.toBeUndefined();

    expect(mockRegisterProtectionOrFlatten).toHaveBeenCalledTimes(2);
    expect(mockRegisterProtectionOrFlatten).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: PROPOSAL_ID_2 }),
      ORDER_ID_2,
      "bot-user-id",
      "recovery",
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      { proposalId: PROPOSAL_ID_1, err: thrown },
      "execution_agent_recovery_row_failed",
    );

    // Isolation must mean accurate PER-ROW counters, not merely that no
    // exception escaped the loop.
    expect(mockLogger.info).toHaveBeenCalledWith(
      { candidates: 2, recovered: 1, stillFailed: 1, skipped: 0 },
      "execution_agent_recovery_done",
    );
  });
});

describe("executionAgentRecoveryJob — summary log gating", () => {
  it("zero candidates: execution_agent_recovery_done is never logged", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await executionAgentRecoveryJob.run(fakeCtx());

    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("nonzero candidates: execution_agent_recovery_done logs exactly once with the correct recovered/stillFailed/skipped/candidates counts", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidateRow()] });
    mockRegisterProtectionOrFlatten.mockResolvedValueOnce(successResult());

    await executionAgentRecoveryJob.run(fakeCtx());

    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      { candidates: 1, recovered: 1, stillFailed: 0, skipped: 0 },
      "execution_agent_recovery_done",
    );
  });
});
