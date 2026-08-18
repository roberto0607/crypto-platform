/**
 * executeTradeProposal (runPhase1 + registerProtectionOrFlatten) tests --
 * pool.connect() fully mocked to a fake PoolClient (same "mock the DB
 * boundary" convention as evaluator.test.ts), placeOrderWithSnapshot/
 * resolveSnapshot/createTriggerOrder/cancelTriggerTx/ensureRiskAgentBotSetup
 * mocked at their module boundaries. Everything is tested through the
 * single exported executeTradeProposal entry point -- runPhase1 and
 * registerProtectionOrFlatten stay unexported, matching evaluator.ts's own
 * "only the public entry point is exported" convention. Where a test
 * needs to prove Phase 2 never ran, it asserts createTriggerOrder was
 * never called rather than spying on registerProtectionOrFlatten directly
 * (same-module function spies don't apply cleanly here).
 *
 * Several of these tests exist specifically to catch regressions found by
 * hand during design review, not just to exercise the happy path -- see
 * the duplicate-trigger and stray-trigger describe blocks below.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const mockClientQuery = vi.fn();
const mockRelease = vi.fn();
const mockConnect = vi.fn();
const mockPoolQuery = vi.fn();
vi.mock("../../../db/pool", () => ({
  pool: { connect: () => mockConnect(), query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

const mockEnsureRiskAgentBotSetup = vi.fn();
vi.mock("../../riskAgent/botSetup", () => ({
  ensureRiskAgentBotSetup: () => mockEnsureRiskAgentBotSetup(),
}));

const mockPlaceOrderWithSnapshot = vi.fn();
const mockResolveSnapshot = vi.fn();
vi.mock("../../../trading/phase6OrderService", () => ({
  placeOrderWithSnapshot: (...args: unknown[]) => mockPlaceOrderWithSnapshot(...args),
  resolveSnapshot: (...args: unknown[]) => mockResolveSnapshot(...args),
}));

const mockCreateTriggerOrder = vi.fn();
const mockCancelTriggerTx = vi.fn();
vi.mock("../../../triggers/triggerRepo", () => ({
  createTriggerOrder: (...args: unknown[]) => mockCreateTriggerOrder(...args),
  cancelTriggerTx: (...args: unknown[]) => mockCancelTriggerTx(...args),
}));

const mockPublish = vi.fn();
vi.mock("../../../events/eventBus", () => ({
  publish: (...args: unknown[]) => mockPublish(...args),
}));

vi.mock("../../../config", () => ({
  config: { riskAgentBotUserId: "bot-user-id", queueTimeoutMs: 5000, opsAlertEmail: "ops@example.com" },
}));

const mockSendEmail = vi.fn();
vi.mock("../../../email/emailTransport", () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
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

import { executeTradeProposal, registerProtectionOrFlatten, type ApprovedProposal } from "../executor";
import { config } from "../../../config";
import { logger } from "../../../observability/logContext";

const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";
const PAIR_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_ID = "33333333-3333-4333-8333-333333333333";
const STOP_TRIGGER_ID = "44444444-4444-4444-8444-444444444444";
const TARGET_TRIGGER_ID = "55555555-5555-4555-8555-555555555555";
const FLATTEN_ORDER_ID = "66666666-6666-4666-8666-666666666666";

const LIVE_SNAPSHOT_AT_ENTRY = { bid: null, ask: null, last: "50000", ts: "2026-01-01T00:00:00Z", source: "live" as const };

function baseProposalRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: PROPOSAL_ID,
    pair_id: PAIR_ID,
    side: "BUY",
    entry_price: "50000.00000000",
    stop_price: "45000.00000000",
    target_price: "55000.00000000",
    qty: "0.20000000",
    stop_distance_pct: "0.1",
    outcome: "approved",
    ...overrides,
  };
}

/** Wires the mock client to a canned proposal row for the initial FOR UPDATE select; every other query (BEGIN/UPDATE/INSERT/COMMIT/ROLLBACK) is captured but doesn't need meaningful rows. */
function setupClient(proposalRow: Record<string, unknown> | undefined) {
  mockClientQuery.mockImplementation((sql: string) => {
    if (typeof sql !== "string") return Promise.resolve({ rows: [] });
    if (sql.includes("FROM trade_proposals") && sql.includes("FOR UPDATE")) {
      return Promise.resolve({ rows: proposalRow ? [proposalRow] : [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

function callsMatching(substr: string) {
  return mockClientQuery.mock.calls.filter(([sql]) => typeof sql === "string" && sql.includes(substr));
}

function entryOrderResolves(orderId: string) {
  return { order: { id: orderId }, fills: [], snapshot: {}, fromIdempotencyCache: false };
}

/**
 * agent_decisions column order (see agentDecisionRepo.ts): agent_name,
 * pair_id, decision, reasoning, regime, regime_confidence, inputs,
 * weights_used, trade_proposal_id, price_at_decision -- so params[3]=
 * reasoning, params[8]=tradeProposalId, params[9]=priceAtDecision. Same
 * indexing evaluator.test.ts uses.
 */
function insertedAgentDecisionParams(decision: string) {
  const call = callsMatching("INSERT INTO agent_decisions").find(
    ([, params]) => (params as unknown[])[2] === decision,
  )!;
  const params = call[1] as unknown[];
  return {
    reasoning: params[3] as string | null,
    tradeProposalId: params[8] as string | null,
    priceAtDecision: params[9] as string | null,
  };
}

function publishedAgentDecision(decision: string) {
  return mockPublish.mock.calls
    .map(([e]) => e)
    .find((e) => e.type === "agent.decision" && e.data.decision === decision);
}

/** Moved here from the registerProtectionOrFlatten origin='recovery' describe
 * block below -- now shared with the new payload-correctness/decisionCommitted
 * tests, which also call registerProtectionOrFlatten directly. */
function baseApprovedProposal(): ApprovedProposal {
  return {
    id: PROPOSAL_ID,
    pair_id: PAIR_ID,
    side: "BUY",
    entry_price: "50000.00000000",
    stop_price: "45000.00000000",
    target_price: "55000.00000000",
    qty: "0.20000000",
    stop_distance_pct: "0.1",
  };
}

beforeEach(() => {
  mockClientQuery.mockReset();
  mockConnect.mockReset();
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease });
  mockRelease.mockClear();
  mockEnsureRiskAgentBotSetup.mockReset();
  mockEnsureRiskAgentBotSetup.mockResolvedValue(undefined);
  mockPlaceOrderWithSnapshot.mockReset();
  mockResolveSnapshot.mockReset();
  mockResolveSnapshot.mockResolvedValue(LIVE_SNAPSHOT_AT_ENTRY);
  mockCreateTriggerOrder.mockReset();
  mockCancelTriggerTx.mockReset();
  mockCancelTriggerTx.mockResolvedValue(null);
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [{ id: PROPOSAL_ID }] }); // claim wins by default
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue(undefined);
  mockPublish.mockClear();
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
});

afterEach(() => {
  // Safety net in case a fake-timers test throws before its own finally.
  vi.useRealTimers();
});

describe("executeTradeProposal — Phase 1 happy path", () => {
  it("places the order, commits outcome='executed' + executed_order_id BEFORE createTriggerOrder is ever called, then proceeds to register protection", async () => {
    setupClient(baseProposalRow());
    mockPlaceOrderWithSnapshot.mockResolvedValueOnce(entryOrderResolves(ORDER_ID));
    mockCreateTriggerOrder
      .mockResolvedValueOnce({ id: STOP_TRIGGER_ID })
      .mockResolvedValueOnce({ id: TARGET_TRIGGER_ID });

    const result = await executeTradeProposal(PROPOSAL_ID);

    expect(result).toEqual({
      proposalId: PROPOSAL_ID,
      outcome: "executed",
      reason: null,
      orderId: ORDER_ID,
      autoFlattened: false,
    });

    const executedUpdateIndex = mockClientQuery.mock.calls.findIndex(
      ([sql]) => typeof sql === "string" && sql.includes("outcome = 'executed'"),
    );
    expect(executedUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(mockClientQuery.mock.calls[executedUpdateIndex]![1]).toEqual([ORDER_ID, PROPOSAL_ID]);
    expect(mockCreateTriggerOrder).toHaveBeenCalledTimes(2);

    // Ordering, not just presence: compare vitest's global invocationCallOrder
    // index across the TWO DIFFERENT mocks to prove the DB commit genuinely
    // happened before Phase 2 started, not just that both eventually ran.
    const executedUpdateOrder = mockClientQuery.mock.invocationCallOrder[executedUpdateIndex]!;
    const firstCreateTriggerOrderOrder = mockCreateTriggerOrder.mock.invocationCallOrder[0]!;
    expect(executedUpdateOrder).toBeLessThan(firstCreateTriggerOrderOrder);
  });
});

describe("executeTradeProposal — Phase 1 idempotency / redelivery safety", () => {
  it("returns skipped('proposal_not_found'), ROLLBACK only, no order placed, no createTriggerOrder call", async () => {
    setupClient(undefined);

    const result = await executeTradeProposal(PROPOSAL_ID);

    expect(result).toEqual({ proposalId: PROPOSAL_ID, outcome: "skipped", reason: "proposal_not_found", orderId: null, autoFlattened: false });
    expect(callsMatching("ROLLBACK")).toHaveLength(1);
    expect(callsMatching("COMMIT")).toHaveLength(0);
    expect(mockPlaceOrderWithSnapshot).not.toHaveBeenCalled();
    expect(mockCreateTriggerOrder).not.toHaveBeenCalled();
  });

  it("returns skipped('already_executed') when outcome is no longer 'approved', ROLLBACK only, no order placed", async () => {
    setupClient(baseProposalRow({ outcome: "executed" }));

    const result = await executeTradeProposal(PROPOSAL_ID);

    expect(result).toEqual({ proposalId: PROPOSAL_ID, outcome: "skipped", reason: "already_executed", orderId: null, autoFlattened: false });
    expect(callsMatching("ROLLBACK")).toHaveLength(1);
    expect(mockPlaceOrderWithSnapshot).not.toHaveBeenCalled();
    expect(mockCreateTriggerOrder).not.toHaveBeenCalled();
  });

  it("returns skipped('already_rejected') when outcome is no longer 'approved', ROLLBACK only, no order placed", async () => {
    setupClient(baseProposalRow({ outcome: "rejected" }));

    const result = await executeTradeProposal(PROPOSAL_ID);

    expect(result).toEqual({ proposalId: PROPOSAL_ID, outcome: "skipped", reason: "already_rejected", orderId: null, autoFlattened: false });
    expect(callsMatching("ROLLBACK")).toHaveLength(1);
    expect(mockPlaceOrderWithSnapshot).not.toHaveBeenCalled();
    expect(mockCreateTriggerOrder).not.toHaveBeenCalled();
  });
});

describe("executeTradeProposal — Phase 1 missing qty / stop_distance_pct guard", () => {
  it("execution_failed('missing_qty_or_stop_distance') when qty is null, no order placed, no createTriggerOrder call", async () => {
    setupClient(baseProposalRow({ qty: null }));

    const result = await executeTradeProposal(PROPOSAL_ID);

    expect(result.outcome).toBe("execution_failed");
    expect(result.reason).toBe("missing_qty_or_stop_distance");
    expect(result.orderId).toBeNull();
    expect(callsMatching("outcome = 'execution_failed'")).toHaveLength(1);
    expect(callsMatching("COMMIT")).toHaveLength(1);
    expect(mockPlaceOrderWithSnapshot).not.toHaveBeenCalled();
    expect(mockCreateTriggerOrder).not.toHaveBeenCalled();
  });

  it("execution_failed('missing_qty_or_stop_distance') when stop_distance_pct is null, no order placed", async () => {
    setupClient(baseProposalRow({ stop_distance_pct: null }));

    const result = await executeTradeProposal(PROPOSAL_ID);

    expect(result.outcome).toBe("execution_failed");
    expect(result.reason).toBe("missing_qty_or_stop_distance");
    expect(mockPlaceOrderWithSnapshot).not.toHaveBeenCalled();
    expect(mockCreateTriggerOrder).not.toHaveBeenCalled();
  });
});

describe("executeTradeProposal — Phase 1 stale price source guard", () => {
  it("execution_failed('stale_price_source') when snapshot.source is 'fallback', BEFORE the tolerance check and before any order placement, no createTriggerOrder call", async () => {
    setupClient(baseProposalRow());
    // currentPrice chosen so it would ALSO fail the tolerance check if
    // reached -- a passing test here proves the stale-source guard ran
    // FIRST (reason is exactly 'stale_price_source', not
    // 'tolerance_exceeded'), not that the tolerance check happened to
    // reject for its own unrelated reason.
    mockResolveSnapshot.mockResolvedValue({ bid: null, ask: null, last: "999999999", ts: "2026-01-01T00:00:00Z", source: "fallback" });

    const result = await executeTradeProposal(PROPOSAL_ID);

    expect(result.outcome).toBe("execution_failed");
    expect(result.reason).toBe("stale_price_source");
    expect(callsMatching("outcome = 'execution_failed'")).toHaveLength(1);
    expect(mockPlaceOrderWithSnapshot).not.toHaveBeenCalled();
    expect(mockCreateTriggerOrder).not.toHaveBeenCalled();
  });
});

describe("executeTradeProposal — Phase 1 tolerance check", () => {
  it("execution_failed('tolerance_exceeded') for a BUY proposal where price rose past the tolerance window (entryPrice=50000, currentPrice=53000, stopDistancePct=0.1)", async () => {
    setupClient(baseProposalRow({ side: "BUY", entry_price: "50000", stop_distance_pct: "0.1" }));
    mockResolveSnapshot.mockResolvedValue({ bid: null, ask: null, last: "53000", ts: "2026-01-01T00:00:00Z", source: "live" });

    const result = await executeTradeProposal(PROPOSAL_ID);

    expect(result.outcome).toBe("execution_failed");
    expect(result.reason).toBe("tolerance_exceeded");
    expect(mockPlaceOrderWithSnapshot).not.toHaveBeenCalled();
    expect(mockCreateTriggerOrder).not.toHaveBeenCalled();
  });

  it("execution_failed('tolerance_exceeded') for a SELL proposal where price fell past the tolerance window (entryPrice=50000, currentPrice=47000, stopDistancePct=0.1)", async () => {
    setupClient(baseProposalRow({ side: "SELL", entry_price: "50000", stop_distance_pct: "0.1" }));
    mockResolveSnapshot.mockResolvedValue({ bid: null, ask: null, last: "47000", ts: "2026-01-01T00:00:00Z", source: "live" });

    const result = await executeTradeProposal(PROPOSAL_ID);

    expect(result.outcome).toBe("execution_failed");
    expect(result.reason).toBe("tolerance_exceeded");
    expect(mockPlaceOrderWithSnapshot).not.toHaveBeenCalled();
    expect(mockCreateTriggerOrder).not.toHaveBeenCalled();
  });
});

describe("executeTradeProposal — Phase 1 order placement failure", () => {
  it("execution_failed('order_placement_failed') when placeOrderWithSnapshot rejects with a real error", async () => {
    setupClient(baseProposalRow());
    mockPlaceOrderWithSnapshot.mockRejectedValueOnce(new Error("insufficient_liquidity"));

    const result = await executeTradeProposal(PROPOSAL_ID);

    expect(result.outcome).toBe("execution_failed");
    expect(result.reason).toBe("order_placement_failed");
    expect(result.orderId).toBeNull();
    expect(mockCreateTriggerOrder).not.toHaveBeenCalled();
  });

  it("execution_failed('order_placement_timeout'), NOT 'order_placement_failed', when placeOrderWithSnapshot never resolves and the Promise.race times out after config.queueTimeoutMs", async () => {
    vi.useFakeTimers();
    try {
      setupClient(baseProposalRow());
      mockPlaceOrderWithSnapshot.mockReturnValueOnce(new Promise(() => {})); // never resolves

      const resultPromise = executeTradeProposal(PROPOSAL_ID);
      await vi.advanceTimersByTimeAsync(5000); // matches mocked config.queueTimeoutMs
      const result = await resultPromise;

      expect(result.outcome).toBe("execution_failed");
      expect(result.reason).toBe("order_placement_timeout");
      expect(result.reason).not.toBe("order_placement_failed");
      expect(mockCreateTriggerOrder).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("executeTradeProposal — Phase 2 happy path", () => {
  it("registers both STOP_MARKET and TAKE_PROFIT_MARKET on the first attempt -> outcome='executed', autoFlattened=false", async () => {
    setupClient(baseProposalRow());
    mockPlaceOrderWithSnapshot.mockResolvedValueOnce(entryOrderResolves(ORDER_ID));
    mockCreateTriggerOrder
      .mockResolvedValueOnce({ id: STOP_TRIGGER_ID })
      .mockResolvedValueOnce({ id: TARGET_TRIGGER_ID });

    const result = await executeTradeProposal(PROPOSAL_ID);

    expect(result).toEqual({ proposalId: PROPOSAL_ID, outcome: "executed", reason: null, orderId: ORDER_ID, autoFlattened: false });
    expect(mockCreateTriggerOrder).toHaveBeenCalledTimes(2);
    expect(mockCreateTriggerOrder.mock.calls[0]![0]).toMatchObject({ kind: "STOP_MARKET", tradeProposalId: PROPOSAL_ID });
    expect(mockCreateTriggerOrder.mock.calls[1]![0]).toMatchObject({ kind: "TAKE_PROFIT_MARKET", tradeProposalId: PROPOSAL_ID });
    expect(mockCancelTriggerTx).not.toHaveBeenCalled();
    expect(mockPlaceOrderWithSnapshot).toHaveBeenCalledTimes(1); // only the entry order -- no flatten
  });
});

describe("executeTradeProposal — agent.decision publish() exception safety (Phase 1, executed path)", () => {
  it("executed: publish() throwing for agent.decision is caught, logged as agent_decision_publish_failed, and executeTradeProposal still proceeds to Phase 2 and returns outcome:'executed' rather than throwing", async () => {
    setupClient(baseProposalRow());
    mockPlaceOrderWithSnapshot.mockResolvedValueOnce(entryOrderResolves(ORDER_ID));
    mockCreateTriggerOrder
      .mockResolvedValueOnce({ id: STOP_TRIGGER_ID })
      .mockResolvedValueOnce({ id: TARGET_TRIGGER_ID });
    mockPublish.mockImplementationOnce(() => {
      throw new Error("publish boom");
    });

    const result = await executeTradeProposal(PROPOSAL_ID);

    expect(result).toEqual({ proposalId: PROPOSAL_ID, outcome: "executed", reason: null, orderId: ORDER_ID, autoFlattened: false });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: PROPOSAL_ID }),
      "agent_decision_publish_failed",
    );
    // Phase 2 still ran despite the Phase 1 publish() failure -- proves the
    // exception was fully contained to its own try/catch, not just that the
    // function eventually returned something.
    expect(mockCreateTriggerOrder).toHaveBeenCalledTimes(2);
  });
});

describe("executeTradeProposal — Phase 2 partial-failure retry (duplicate-trigger regression guard)", () => {
  it("retries only the missing leg after a partial failure -- createTriggerOrder for STOP_MARKET is called exactly once across both attempts when only TAKE_PROFIT_MARKET fails on attempt 1", async () => {
    vi.useFakeTimers();
    try {
      setupClient(baseProposalRow());
      mockPlaceOrderWithSnapshot.mockResolvedValueOnce(entryOrderResolves(ORDER_ID));
      mockCreateTriggerOrder
        .mockResolvedValueOnce({ id: STOP_TRIGGER_ID }) // attempt 1: STOP_MARKET succeeds
        .mockRejectedValueOnce(new Error("transient_db_error")) // attempt 1: TAKE_PROFIT_MARKET fails
        .mockResolvedValueOnce({ id: TARGET_TRIGGER_ID }); // attempt 2: TAKE_PROFIT_MARKET succeeds; STOP_MARKET must NOT be re-called

      const resultPromise = executeTradeProposal(PROPOSAL_ID);
      await vi.advanceTimersByTimeAsync(500); // one retry delay between the two attempts
      const result = await resultPromise;

      expect(result).toEqual({ proposalId: PROPOSAL_ID, outcome: "executed", reason: null, orderId: ORDER_ID, autoFlattened: false });

      // The regression this guards against: blindly re-running BOTH legs
      // on retry would produce 4 total calls (2 legs x 2 attempts), with
      // TWO ACTIVE STOP_MARKET rows for the same position. Exactly 3
      // calls (1 STOP + 2 TAKE_PROFIT) proves the fix.
      expect(mockCreateTriggerOrder).toHaveBeenCalledTimes(3);
      const stopCalls = mockCreateTriggerOrder.mock.calls.filter(([params]) => params.kind === "STOP_MARKET");
      expect(stopCalls).toHaveLength(1);
      const targetCalls = mockCreateTriggerOrder.mock.calls.filter(([params]) => params.kind === "TAKE_PROFIT_MARKET");
      expect(targetCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("executeTradeProposal — Phase 2 auto-flatten, zero legs registered", () => {
  it("exhausts all retries with neither leg ever registering, auto-flattens, and calls cancelTriggerTx zero times", async () => {
    vi.useFakeTimers();
    try {
      setupClient(baseProposalRow());
      mockPlaceOrderWithSnapshot
        .mockResolvedValueOnce(entryOrderResolves(ORDER_ID))
        .mockResolvedValueOnce(entryOrderResolves(FLATTEN_ORDER_ID));
      // STOP_MARKET fails on every attempt. The loop is sequential and
      // short-circuits on the first throw within an attempt, so
      // TAKE_PROFIT_MARKET is never even reached -- this is a genuine
      // "zero legs ever registered" scenario (3 calls total, all
      // STOP_MARKET), not a test artifact.
      mockCreateTriggerOrder.mockRejectedValue(new Error("persistent_db_error"));

      const resultPromise = executeTradeProposal(PROPOSAL_ID);
      await vi.advanceTimersByTimeAsync(500 * 2); // two retry delays across three attempts
      const result = await resultPromise;

      expect(result).toEqual({ proposalId: PROPOSAL_ID, outcome: "executed", reason: "auto_flattened", orderId: ORDER_ID, autoFlattened: true });
      expect(mockCreateTriggerOrder).toHaveBeenCalledTimes(3);
      expect(mockCreateTriggerOrder.mock.calls.every(([params]) => params.kind === "STOP_MARKET")).toBe(true);
      expect(mockCancelTriggerTx).not.toHaveBeenCalled();
      expect(mockPlaceOrderWithSnapshot).toHaveBeenCalledTimes(2); // entry + flatten
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("executeTradeProposal — Phase 2 auto-flatten, one leg registered (stray-trigger regression guard)", () => {
  it("exhausts retries with only STOP_MARKET having registered -- cancelTriggerTx is called exactly once, with that trigger's id, BEFORE the flatten order is placed", async () => {
    vi.useFakeTimers();
    try {
      setupClient(baseProposalRow());
      mockPlaceOrderWithSnapshot
        .mockResolvedValueOnce(entryOrderResolves(ORDER_ID))
        .mockResolvedValueOnce(entryOrderResolves(FLATTEN_ORDER_ID));
      mockCreateTriggerOrder
        .mockResolvedValueOnce({ id: STOP_TRIGGER_ID }) // attempt 1: STOP_MARKET succeeds
        .mockRejectedValueOnce(new Error("fail-1")) // attempt 1: TAKE_PROFIT_MARKET fails
        .mockRejectedValueOnce(new Error("fail-2")) // attempt 2: TAKE_PROFIT_MARKET fails (STOP_MARKET skipped -- already registered)
        .mockRejectedValueOnce(new Error("fail-3")); // attempt 3: TAKE_PROFIT_MARKET fails

      const resultPromise = executeTradeProposal(PROPOSAL_ID);
      await vi.advanceTimersByTimeAsync(500 * 2);
      const result = await resultPromise;

      expect(result).toEqual({ proposalId: PROPOSAL_ID, outcome: "executed", reason: "auto_flattened", orderId: ORDER_ID, autoFlattened: true });
      expect(mockCreateTriggerOrder).toHaveBeenCalledTimes(4); // 1 STOP success + 3 TAKE_PROFIT failures
      expect(mockCancelTriggerTx).toHaveBeenCalledTimes(1);
      expect(mockCancelTriggerTx.mock.calls[0]![1]).toBe(STOP_TRIGGER_ID); // (client, triggerId)

      // Ordering: the surviving leg must be canceled BEFORE the flatten
      // order is placed, not after -- otherwise the stray trigger is
      // briefly (or permanently, if flatten fails) left ACTIVE against a
      // position already being closed.
      const cancelOrder = mockCancelTriggerTx.mock.invocationCallOrder[0]!;
      const flattenOrder = mockPlaceOrderWithSnapshot.mock.invocationCallOrder[1]!; // [0]=entry, [1]=flatten
      expect(cancelOrder).toBeLessThan(flattenOrder);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("executeTradeProposal — Phase 2 auto-flatten outcome", () => {
  it("auto-flatten succeeds -- outcome stays 'executed', autoFlattened=true, agent_decisions reasoning references the flattenOrderId", async () => {
    vi.useFakeTimers();
    try {
      setupClient(baseProposalRow());
      mockPlaceOrderWithSnapshot
        .mockResolvedValueOnce(entryOrderResolves(ORDER_ID))
        .mockResolvedValueOnce(entryOrderResolves(FLATTEN_ORDER_ID));
      mockCreateTriggerOrder.mockRejectedValue(new Error("persistent_db_error"));

      const resultPromise = executeTradeProposal(PROPOSAL_ID);
      await vi.advanceTimersByTimeAsync(500 * 2);
      const result = await resultPromise;

      expect(result.outcome).toBe("executed");
      expect(result.autoFlattened).toBe(true);

      // agent_decisions column order: agent_name, pair_id, decision,
      // reasoning, ... (see agentDecisionRepo.ts) -- params[2]=decision,
      // params[3]=reasoning, same indexing evaluator.test.ts already uses.
      const decisionInsert = callsMatching("INSERT INTO agent_decisions").find(
        ([, params]) => (params as unknown[])[2] === "auto_flattened",
      );
      expect(decisionInsert).toBeDefined();
      const reasoning = decisionInsert![1][3] as string;
      expect(reasoning).toContain(FLATTEN_ORDER_ID);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-flatten ALSO fails -- agent_decisions reasoning contains 'UNPROTECTED', and executeTradeProposal still returns a result rather than throwing", async () => {
    vi.useFakeTimers();
    try {
      setupClient(baseProposalRow());
      mockPlaceOrderWithSnapshot
        .mockResolvedValueOnce(entryOrderResolves(ORDER_ID)) // entry order succeeds
        .mockRejectedValueOnce(new Error("flatten_also_fails")); // flatten order fails too
      mockCreateTriggerOrder.mockRejectedValue(new Error("persistent_db_error"));

      const resultPromise = executeTradeProposal(PROPOSAL_ID);
      await vi.advanceTimersByTimeAsync(500 * 2);

      // If registerProtectionOrFlatten threw here instead of returning,
      // this await would reject and the test would fail on that alone --
      // no separate "did not throw" assertion needed.
      const result = await resultPromise;

      expect(result.outcome).toBe("executed");
      expect(result.autoFlattened).toBe(true);
      expect(result.reason).toBe("auto_flattened");

      const decisionInsert = callsMatching("INSERT INTO agent_decisions").find(
        ([, params]) => (params as unknown[])[2] === "auto_flattened",
      );
      expect(decisionInsert).toBeDefined();
      const reasoning = decisionInsert![1][3] as string;
      expect(reasoning).toContain("UNPROTECTED");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("executeTradeProposal — agent.decision payload correctness", () => {
  it("execution_failed (stale_price_source): reasoning/tradeProposalId/priceAtDecision exactly match the agent_decisions INSERT", async () => {
    setupClient(baseProposalRow());
    mockResolveSnapshot.mockResolvedValue({ bid: null, ask: null, last: "999999999", ts: "2026-01-01T00:00:00Z", source: "fallback" });

    await executeTradeProposal(PROPOSAL_ID);

    const inserted = insertedAgentDecisionParams("execution_failed");
    const published = publishedAgentDecision("execution_failed");
    expect(published).toBeDefined();
    expect(published!.data.reasoning).toBe(inserted.reasoning);
    expect(published!.data.tradeProposalId).toBe(inserted.tradeProposalId);
    expect(published!.data.priceAtDecision).toBe(inserted.priceAtDecision);
  });

  it("executed: reasoning/tradeProposalId/priceAtDecision exactly match the agent_decisions INSERT", async () => {
    setupClient(baseProposalRow());
    mockPlaceOrderWithSnapshot.mockResolvedValueOnce(entryOrderResolves(ORDER_ID));
    mockCreateTriggerOrder
      .mockResolvedValueOnce({ id: STOP_TRIGGER_ID })
      .mockResolvedValueOnce({ id: TARGET_TRIGGER_ID });

    await executeTradeProposal(PROPOSAL_ID);

    const inserted = insertedAgentDecisionParams("executed");
    const published = publishedAgentDecision("executed");
    expect(published).toBeDefined();
    expect(published!.data.reasoning).toBe(inserted.reasoning);
    expect(published!.data.tradeProposalId).toBe(inserted.tradeProposalId);
    expect(published!.data.priceAtDecision).toBe(inserted.priceAtDecision);
  });

  it("auto_flattened: decision/reasoning/tradeProposalId exactly match the agent_decisions INSERT (priceAtDecision null)", async () => {
    vi.useFakeTimers();
    try {
      setupClient(baseProposalRow());
      mockPlaceOrderWithSnapshot
        .mockResolvedValueOnce(entryOrderResolves(ORDER_ID))
        .mockResolvedValueOnce(entryOrderResolves(FLATTEN_ORDER_ID));
      mockCreateTriggerOrder.mockRejectedValue(new Error("persistent_db_error"));

      const resultPromise = executeTradeProposal(PROPOSAL_ID);
      await vi.advanceTimersByTimeAsync(500 * 2);
      await resultPromise;

      const inserted = insertedAgentDecisionParams("auto_flattened");
      const published = publishedAgentDecision("auto_flattened");
      expect(published).toBeDefined();
      expect(published!.data.reasoning).toBe(inserted.reasoning);
      expect(published!.data.tradeProposalId).toBe(inserted.tradeProposalId);
      expect(inserted.priceAtDecision).toBeNull();
      expect(published!.data.priceAtDecision).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovery_also_failed: decision/reasoning/tradeProposalId exactly match the agent_decisions INSERT (priceAtDecision null)", async () => {
    vi.useFakeTimers();
    try {
      setupClient(undefined);
      mockCreateTriggerOrder.mockRejectedValue(new Error("persistent_db_error"));
      mockPlaceOrderWithSnapshot.mockRejectedValueOnce(new Error("flatten_also_fails"));

      const resultPromise = registerProtectionOrFlatten(baseApprovedProposal(), ORDER_ID, "bot-user-id", "recovery");
      await vi.advanceTimersByTimeAsync(500 * 2);
      await resultPromise;

      const inserted = insertedAgentDecisionParams("recovery_also_failed");
      const published = publishedAgentDecision("recovery_also_failed");
      expect(published).toBeDefined();
      expect(published!.data.reasoning).toBe(inserted.reasoning);
      expect(published!.data.tradeProposalId).toBe(inserted.tradeProposalId);
      expect(inserted.priceAtDecision).toBeNull();
      expect(published!.data.priceAtDecision).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("registerProtectionOrFlatten — origin='recovery' human-alerting escalation", () => {
  /** Drives registerProtectionOrFlatten to the recovery_also_failed branch: all trigger-registration retries exhausted AND the flatten attempt fails too. */
  async function runRecoveryAlsoFailed() {
    setupClient(undefined);
    mockCreateTriggerOrder.mockRejectedValue(new Error("persistent_db_error"));
    mockPlaceOrderWithSnapshot.mockRejectedValueOnce(new Error("flatten_also_fails"));

    const resultPromise = registerProtectionOrFlatten(baseApprovedProposal(), ORDER_ID, "bot-user-id", "recovery");
    await vi.advanceTimersByTimeAsync(500 * 2); // two retry delays across three attempts
    return resultPromise;
  }

  it("claim wins (human_alerted_at was NULL) and opsAlertEmail is configured -- sends exactly one email to config.opsAlertEmail referencing the proposal, order, and pair", async () => {
    vi.useFakeTimers();
    try {
      const result = await runRecoveryAlsoFailed();

      expect(result.reason).toBe("recovery_also_failed");
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("SET human_alerted_at = now()"),
        [PROPOSAL_ID],
      );
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      const [to, subject, html] = mockSendEmail.mock.calls[0]!;
      expect(to).toBe("ops@example.com");
      expect(subject).toContain(PAIR_ID);
      expect(html).toContain(PROPOSAL_ID);
      expect(html).toContain(ORDER_ID);
    } finally {
      vi.useRealTimers();
    }
  });

  it("claim loses (human_alerted_at already set by a concurrent tick/instance) -- does not send an email", async () => {
    vi.useFakeTimers();
    try {
      mockPoolQuery.mockResolvedValue({ rows: [] }); // another caller already won the claim
      const result = await runRecoveryAlsoFailed();

      expect(result.reason).toBe("recovery_also_failed");
      expect(mockSendEmail).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opsAlertEmail is unset -- claim still wins (human_alerted_at gets set so no future tick re-claims it) but no email is sent", async () => {
    const originalOpsAlertEmail = config.opsAlertEmail;
    (config as { opsAlertEmail: string }).opsAlertEmail = "";
    vi.useFakeTimers();
    try {
      const result = await runRecoveryAlsoFailed();

      expect(result.reason).toBe("recovery_also_failed");
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("SET human_alerted_at = now()"),
        [PROPOSAL_ID],
      );
      expect(mockSendEmail).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      (config as { opsAlertEmail: string }).opsAlertEmail = originalOpsAlertEmail;
    }
  });

  it("sendEmail rejects -- caught and logged, agent_decisions insert still runs, registerProtectionOrFlatten still returns normally rather than rejecting", async () => {
    vi.useFakeTimers();
    try {
      mockSendEmail.mockRejectedValueOnce(new Error("sendgrid_down"));

      // If alertHumanOnRecoveryFailure let this propagate, this await
      // would reject and the test would fail on that alone -- no
      // separate "did not throw" assertion needed.
      const result = await runRecoveryAlsoFailed();

      expect(result.reason).toBe("recovery_also_failed");
      const decisionInsert = callsMatching("INSERT INTO agent_decisions").find(
        ([, params]) => (params as unknown[])[2] === "recovery_also_failed",
      );
      expect(decisionInsert).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the claim UPDATE itself throws (simulated DB error) -- caught and logged, sendEmail never called, agent_decisions insert still runs, registerProtectionOrFlatten still returns normally rather than rejecting", async () => {
    vi.useFakeTimers();
    try {
      mockPoolQuery.mockRejectedValueOnce(new Error("connection_terminated"));

      // Same "would reject on its own if uncaught" reasoning as above --
      // this is the case the fix was specifically added for: a failure
      // in the claim query, not just the send, must not block the
      // primary agent_decisions write below it.
      const result = await runRecoveryAlsoFailed();

      expect(result.reason).toBe("recovery_also_failed");
      expect(mockSendEmail).not.toHaveBeenCalled();
      const decisionInsert = callsMatching("INSERT INTO agent_decisions").find(
        ([, params]) => (params as unknown[])[2] === "recovery_also_failed",
      );
      expect(decisionInsert).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("registerProtectionOrFlatten — decisionCommitted gate", () => {
  it("decisionClient transaction fails (simulated decisionErr) on the auto_flattened path -- agent.decision is NEVER published, even though execution_agent_auto_flatten_decision_log_failed is logged", async () => {
    vi.useFakeTimers();
    try {
      mockClientQuery.mockImplementation((sql: string) => {
        if (typeof sql === "string" && sql.includes("INSERT INTO agent_decisions")) {
          return Promise.reject(new Error("db_write_failed"));
        }
        return Promise.resolve({ rows: [] });
      });
      mockCreateTriggerOrder.mockRejectedValue(new Error("persistent_db_error"));
      mockPlaceOrderWithSnapshot.mockResolvedValueOnce(entryOrderResolves(FLATTEN_ORDER_ID));

      const resultPromise = registerProtectionOrFlatten(baseApprovedProposal(), ORDER_ID, "bot-user-id", "phase2");
      await vi.advanceTimersByTimeAsync(500 * 2);
      const result = await resultPromise;

      expect(result.reason).toBe("auto_flattened");
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ proposalId: PROPOSAL_ID }),
        "execution_agent_auto_flatten_decision_log_failed",
      );
      const agentDecisionCalls = mockPublish.mock.calls.filter(([e]) => e.type === "agent.decision");
      expect(agentDecisionCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("decisionClient transaction fails (simulated decisionErr) on the recovery_also_failed path (origin='recovery') -- agent.decision is NEVER published either", async () => {
    vi.useFakeTimers();
    try {
      mockClientQuery.mockImplementation((sql: string) => {
        if (typeof sql === "string" && sql.includes("INSERT INTO agent_decisions")) {
          return Promise.reject(new Error("db_write_failed"));
        }
        return Promise.resolve({ rows: [] });
      });
      mockCreateTriggerOrder.mockRejectedValue(new Error("persistent_db_error"));
      mockPlaceOrderWithSnapshot.mockRejectedValueOnce(new Error("flatten_also_fails"));

      const resultPromise = registerProtectionOrFlatten(baseApprovedProposal(), ORDER_ID, "bot-user-id", "recovery");
      await vi.advanceTimersByTimeAsync(500 * 2);
      const result = await resultPromise;

      expect(result.reason).toBe("recovery_also_failed");
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ proposalId: PROPOSAL_ID }),
        "execution_agent_auto_flatten_decision_log_failed",
      );
      const agentDecisionCalls = mockPublish.mock.calls.filter(([e]) => e.type === "agent.decision");
      expect(agentDecisionCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("registerProtectionOrFlatten — agent.decision publish() exception safety", () => {
  it("auto_flattened: decisionClient commits successfully but publish() throws -- caught, logged as agent_decision_publish_failed (NOT execution_agent_auto_flatten_decision_log_failed), and registerProtectionOrFlatten still returns outcome:'executed', autoFlattened:true", async () => {
    vi.useFakeTimers();
    try {
      setupClient(undefined);
      mockCreateTriggerOrder.mockRejectedValue(new Error("persistent_db_error"));
      mockPlaceOrderWithSnapshot.mockResolvedValueOnce(entryOrderResolves(FLATTEN_ORDER_ID));
      mockPublish.mockImplementationOnce(() => {
        throw new Error("publish boom");
      });

      const resultPromise = registerProtectionOrFlatten(baseApprovedProposal(), ORDER_ID, "bot-user-id", "phase2");
      await vi.advanceTimersByTimeAsync(500 * 2);
      const result = await resultPromise;

      expect(result).toEqual({ proposalId: PROPOSAL_ID, outcome: "executed", reason: "auto_flattened", orderId: ORDER_ID, autoFlattened: true });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ proposalId: PROPOSAL_ID }),
        "agent_decision_publish_failed",
      );
      expect(logger.error).not.toHaveBeenCalledWith(
        expect.anything(),
        "execution_agent_auto_flatten_decision_log_failed",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
