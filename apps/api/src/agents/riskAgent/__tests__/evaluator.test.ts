/**
 * Risk Agent evaluator tests — pool.connect() fully mocked to a fake
 * PoolClient (same "mock the DB boundary" convention as
 * chartAnalysis/scanner runner tests), so these assert the deterministic
 * decision logic (sizing formula, exposure cap, expiry, guards,
 * idempotency-on-redelivery) without needing a real Postgres transaction.
 * botSetup and getPortfolioSummary are mocked too, since evaluator.ts's
 * own job is the decision math, not wallet bootstrapping or portfolio
 * aggregation (those have their own tests elsewhere).
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

const mockClientQuery = vi.fn();
const mockRelease = vi.fn();
const mockConnect = vi.fn();
vi.mock("../../../db/pool", () => ({
  pool: { connect: () => mockConnect() },
}));

const mockGetPortfolioSummary = vi.fn();
vi.mock("../../../portfolio/portfolioService", () => ({
  getPortfolioSummary: (...args: unknown[]) => mockGetPortfolioSummary(...args),
}));

const mockEnsureRiskAgentBotSetup = vi.fn();
vi.mock("../botSetup", () => ({
  ensureRiskAgentBotSetup: () => mockEnsureRiskAgentBotSetup(),
}));

vi.mock("../../../config", () => ({
  config: { riskAgentBotUserId: "bot-user-id" },
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

import { evaluateTradeProposal } from "../evaluator";

const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";
const PAIR_ID = "22222222-2222-4222-8222-222222222222";

const FUTURE_EXPIRY = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST_EXPIRY = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function baseProposalRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: PROPOSAL_ID,
    pair_id: PAIR_ID,
    outcome: "pending",
    entry_price: "50000.00000000",
    stop_price: "49500.00000000",
    stop_distance_pct: "0.01",
    expires_at: FUTURE_EXPIRY,
    ...overrides,
  };
}

/** Wires the mock client to a canned proposal row + open-risk sum, and captures every query call. */
function setupClient(proposalRow: Record<string, unknown> | undefined, totalOpenRisk = "0") {
  mockClientQuery.mockImplementation((sql: string) => {
    if (typeof sql !== "string") return Promise.resolve({ rows: [] });
    if (sql.includes("FROM trade_proposals") && sql.includes("FOR UPDATE")) {
      return Promise.resolve({ rows: proposalRow ? [proposalRow] : [] });
    }
    if (sql.includes("SELECT COALESCE(SUM(r.risk_amount_quote)")) {
      return Promise.resolve({ rows: [{ total_open_risk: totalOpenRisk }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

function callsMatching(substr: string) {
  return mockClientQuery.mock.calls.filter(([sql]) => typeof sql === "string" && sql.includes(substr));
}

beforeEach(() => {
  mockClientQuery.mockReset();
  mockConnect.mockReset();
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease });
  mockRelease.mockClear();
  mockGetPortfolioSummary.mockReset();
  mockGetPortfolioSummary.mockResolvedValue({ equity_quote: "100000.00000000" });
  mockEnsureRiskAgentBotSetup.mockReset();
  mockEnsureRiskAgentBotSetup.mockResolvedValue(undefined);
});

describe("evaluateTradeProposal — approval + sizing", () => {
  it("approves and sizes qty via fixed-fractional risk when well within the exposure cap", async () => {
    // equity 100000, risk/trade 1% -> riskAmountQuote 1000
    // entry 50000, stopDistancePct 0.01 -> qty = 1000 / (50000 * 0.01) = 2
    setupClient(baseProposalRow(), "0");

    const result = await evaluateTradeProposal(PROPOSAL_ID);

    expect(result.decision).toBe("approved");
    expect(result.qty).toBe("2.00000000");
    expect(result.riskAmountQuote).toBe("1000.00000000");

    const approveUpdate = callsMatching("outcome = 'approved'");
    expect(approveUpdate).toHaveLength(1);
    expect(approveUpdate[0]![1]).toEqual(["2.00000000", PROPOSAL_ID]);

    const reservationInsert = callsMatching("INSERT INTO risk_reservations");
    expect(reservationInsert).toHaveLength(1);
    expect(reservationInsert[0]![1]).toEqual([PROPOSAL_ID, "bot-user-id", PAIR_ID, "1000.00000000"]);

    const decisionInsert = callsMatching("INSERT INTO agent_decisions");
    expect(decisionInsert).toHaveLength(1);
    expect(decisionInsert[0]![1][2]).toBe("approved"); // decision column

    expect(callsMatching("COMMIT")).toHaveLength(1);
    expect(callsMatching("ROLLBACK")).toHaveLength(0);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

describe("evaluateTradeProposal — exposure cap", () => {
  it("rejects when adding this proposal's risk would exceed the 5% total-open-risk cap", async () => {
    // equity 100000 -> cap 5000. Already-reserved 4500 + this proposal's
    // 1000 = 5500 > 5000 -> reject.
    setupClient(baseProposalRow(), "4500");

    const result = await evaluateTradeProposal(PROPOSAL_ID);

    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("exposure_cap_exceeded");
    expect(result.qty).toBeNull();

    expect(callsMatching("INSERT INTO risk_reservations")).toHaveLength(0);
    const rejectUpdate = callsMatching("outcome = 'rejected'");
    expect(rejectUpdate).toHaveLength(1);
    expect(rejectUpdate[0]![1]).toEqual([PROPOSAL_ID]);

    const decisionInsert = callsMatching("INSERT INTO agent_decisions");
    expect(decisionInsert[0]![1][2]).toBe("rejected");
    expect(callsMatching("COMMIT")).toHaveLength(1);
  });

  it("approves at exactly the cap boundary (newTotal == cap is not 'exceeded')", async () => {
    // 4000 already reserved + 1000 this proposal = 5000 == cap exactly.
    setupClient(baseProposalRow(), "4000");

    const result = await evaluateTradeProposal(PROPOSAL_ID);

    expect(result.decision).toBe("approved");
  });
});

describe("evaluateTradeProposal — expiry", () => {
  it("marks the proposal expired and skips sizing entirely when expires_at has already passed", async () => {
    setupClient(baseProposalRow({ expires_at: PAST_EXPIRY }));

    const result = await evaluateTradeProposal(PROPOSAL_ID);

    expect(result.decision).toBe("expired");
    expect(mockGetPortfolioSummary).not.toHaveBeenCalled();
    expect(callsMatching("outcome = 'expired'")).toHaveLength(1);
    const decisionInsert = callsMatching("INSERT INTO agent_decisions");
    expect(decisionInsert[0]![1][2]).toBe("expired");
    expect(callsMatching("COMMIT")).toHaveLength(1);
  });
});

describe("evaluateTradeProposal — division-by-zero / missing stop-distance guard", () => {
  it("rejects instead of dividing by a null stop_distance_pct", async () => {
    setupClient(baseProposalRow({ stop_distance_pct: null }));

    const result = await evaluateTradeProposal(PROPOSAL_ID);

    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("missing_or_invalid_stop_distance");
    expect(mockGetPortfolioSummary).not.toHaveBeenCalled();
    expect(callsMatching("INSERT INTO risk_reservations")).toHaveLength(0);
  });

  it("rejects a zero stop_distance_pct the same way", async () => {
    setupClient(baseProposalRow({ stop_distance_pct: "0" }));

    const result = await evaluateTradeProposal(PROPOSAL_ID);

    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("missing_or_invalid_stop_distance");
  });
});

describe("evaluateTradeProposal — idempotency / redelivery safety", () => {
  it("skips without mutating anything when the proposal row no longer exists", async () => {
    setupClient(undefined);

    const result = await evaluateTradeProposal(PROPOSAL_ID);

    expect(result.decision).toBe("skipped");
    expect(result.reason).toBe("proposal_not_found");
    expect(callsMatching("COMMIT")).toHaveLength(0);
    expect(callsMatching("ROLLBACK")).toHaveLength(1);
  });

  it("skips re-evaluation when the proposal's outcome is no longer 'pending'", async () => {
    setupClient(baseProposalRow({ outcome: "approved" }));

    const result = await evaluateTradeProposal(PROPOSAL_ID);

    expect(result.decision).toBe("skipped");
    expect(result.reason).toBe("already_approved");
    expect(mockGetPortfolioSummary).not.toHaveBeenCalled();
    expect(callsMatching("ROLLBACK")).toHaveLength(1);
  });
});

describe("evaluateTradeProposal — unexpected failure", () => {
  it("rolls back and rethrows when an unexpected error occurs mid-evaluation", async () => {
    setupClient(baseProposalRow(), "0");
    mockGetPortfolioSummary.mockRejectedValueOnce(new Error("db unreachable"));

    await expect(evaluateTradeProposal(PROPOSAL_ID)).rejects.toThrow("db unreachable");

    expect(callsMatching("ROLLBACK")).toHaveLength(1);
    expect(callsMatching("COMMIT")).toHaveLength(0);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
