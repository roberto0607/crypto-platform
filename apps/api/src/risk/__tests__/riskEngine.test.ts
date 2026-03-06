import { describe, it, expect, vi, beforeEach } from "vitest";
import { evaluateOrderRisk } from "../riskEngine";
import { RISK_CODES } from "../riskTypes";
import type { RiskCheckInput } from "../riskTypes";

// ── Mocks ──

vi.mock("../../db/pool", () => ({ pool: {} }));

vi.mock("../riskLimitRepo", () => ({
  resolveEffectiveLimits: vi.fn(),
}));

vi.mock("../breakerRepo", () => ({
  getOpenBreakers: vi.fn(),
}));

vi.mock("../breakerService", () => ({
  priceDislocationKey: (pairId: string) => `PRICE_DISLOCATION:PAIR:${pairId}`,
  rateAbuseKey: (userId: string) => `RATE_ABUSE:USER:${userId}`,
  RECONCILIATION_KEY: "RECONCILIATION_CRITICAL",
}));

vi.mock("../../metrics", () => ({
  riskChecksTotal: { inc: vi.fn() },
  riskRejectionsTotal: { inc: vi.fn() },
  breakerBlocksTotal: { inc: vi.fn() },
  riskEvaluationLatency: { observe: vi.fn() },
}));

import { resolveEffectiveLimits } from "../riskLimitRepo";
import { getOpenBreakers } from "../breakerRepo";

const mockResolve = vi.mocked(resolveEffectiveLimits);
const mockBreakers = vi.mocked(getOpenBreakers);

// ── Helpers ──

const defaultLimits = {
  max_order_notional_quote: "100000.00000000",
  max_position_base_qty: "1000.00000000",
  max_open_orders_per_pair: 50,
  max_price_deviation_bps: 500,
};

const snapshot = { bid: "50000", ask: "50100", last: "50000.00000000", ts: "2026-01-01T00:00:00Z", source: "live" };

function makeInput(overrides: Partial<RiskCheckInput> = {}): RiskCheckInput {
  return {
    userId: "u1",
    pairId: "p1",
    side: "BUY",
    type: "LIMIT",
    qty: "1.00000000",
    limitPrice: "50000.00000000",
    snapshot,
    ...overrides,
  };
}

const mockClient = {
  query: vi.fn(),
} as any;

/** Set up mockClient.query to return specific values based on SQL content. */
function setQueryMock(openCount = "0", positionBaseQty: string | null = null) {
  mockClient.query.mockImplementation((sql: string) => {
    if (sql.includes("COUNT(*)")) {
      return Promise.resolve({ rows: [{ cnt: openCount }] });
    }
    if (sql.includes("positions")) {
      return positionBaseQty !== null
        ? Promise.resolve({ rows: [{ base_qty: positionBaseQty }] })
        : Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

// ── Tests ──

describe("evaluateOrderRisk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.query.mockReset();
    mockResolve.mockResolvedValue(defaultLimits);
    mockBreakers.mockResolvedValue([]);
    // Default: 0 open orders, no position
    setQueryMock("0", null);
  });

  it("passes when all checks are within limits", async () => {
    const result = await evaluateOrderRisk(mockClient, makeInput());
    expect(result.ok).toBe(true);
    expect(result.code).toBe(RISK_CODES.PASS);
  });

  it("rejects invalid qty (zero)", async () => {
    const result = await evaluateOrderRisk(mockClient, makeInput({ qty: "0" }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe(RISK_CODES.INVALID_QTY);
  });

  it("rejects invalid qty (negative)", async () => {
    const result = await evaluateOrderRisk(mockClient, makeInput({ qty: "-1" }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe(RISK_CODES.INVALID_QTY);
  });

  it("rejects invalid qty (too many decimals)", async () => {
    const result = await evaluateOrderRisk(mockClient, makeInput({ qty: "1.123456789" }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe(RISK_CODES.INVALID_QTY);
  });

  it("rejects when breaker is OPEN", async () => {
    mockBreakers.mockResolvedValue([
      { id: "b1", breaker_key: "RECONCILIATION_CRITICAL", status: "OPEN", opened_at: null, closes_at: null, reason: "test", metadata: {}, created_at: "", updated_at: "" },
    ] as any);

    const result = await evaluateOrderRisk(mockClient, makeInput());
    expect(result.ok).toBe(false);
    expect(result.code).toBe(RISK_CODES.BREAKER_OPEN);
    expect(result.details?.breaker_key).toBe("RECONCILIATION_CRITICAL");
  });

  it("rejects when order notional exceeds limit", async () => {
    mockResolve.mockResolvedValue({
      ...defaultLimits,
      max_order_notional_quote: "1000.00000000",
    });

    // qty=1 * price=50000 = 50000 notional > 1000 limit
    const result = await evaluateOrderRisk(mockClient, makeInput());
    expect(result.ok).toBe(false);
    expect(result.code).toBe(RISK_CODES.MAX_NOTIONAL_EXCEEDED);
  });

  it("rejects fat-finger LIMIT with deviation > max bps", async () => {
    mockResolve.mockResolvedValue({
      ...defaultLimits,
      max_price_deviation_bps: 100, // 1%
    });

    // limitPrice 55000 vs last 50000 = 10% deviation = 1000 bps > 100 limit
    const result = await evaluateOrderRisk(mockClient, makeInput({
      limitPrice: "55000.00000000",
    }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe(RISK_CODES.PRICE_DEVIATION_EXCEEDED);
  });

  it("skips deviation check for MARKET orders", async () => {
    const result = await evaluateOrderRisk(mockClient, makeInput({
      type: "MARKET",
      limitPrice: undefined,
    }));
    expect(result.ok).toBe(true);
    expect(result.code).toBe(RISK_CODES.PASS);
  });

  it("MARKET order uses snapshot.last for notional calc", async () => {
    mockResolve.mockResolvedValue({
      ...defaultLimits,
      max_order_notional_quote: "1000.00000000",
    });

    // qty=1 * snapshot.last=50000 = 50000 > 1000
    const result = await evaluateOrderRisk(mockClient, makeInput({
      type: "MARKET",
      limitPrice: undefined,
    }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe(RISK_CODES.MAX_NOTIONAL_EXCEEDED);
  });

  it("rejects when max open orders exceeded", async () => {
    mockResolve.mockResolvedValue({
      ...defaultLimits,
      max_open_orders_per_pair: 5,
    });
    setQueryMock("5", null); // 5 open = at limit

    const result = await evaluateOrderRisk(mockClient, makeInput());
    expect(result.ok).toBe(false);
    expect(result.code).toBe(RISK_CODES.MAX_OPEN_ORDERS_EXCEEDED);
  });

  it("rejects when projected position exceeds max", async () => {
    mockResolve.mockResolvedValue({
      ...defaultLimits,
      max_position_base_qty: "10.00000000",
    });
    setQueryMock("0", "9.50000000"); // current = 9.5

    // BUY 1 more => projected = 10.5 > 10 limit
    const result = await evaluateOrderRisk(mockClient, makeInput());
    expect(result.ok).toBe(false);
    expect(result.code).toBe(RISK_CODES.MAX_POSITION_EXCEEDED);
  });

  it("allows position exactly at limit", async () => {
    mockResolve.mockResolvedValue({
      ...defaultLimits,
      max_position_base_qty: "10.00000000",
    });
    setQueryMock("0", "9.00000000"); // current = 9

    // BUY 1 => projected = 10 = limit (not exceeded)
    const result = await evaluateOrderRisk(mockClient, makeInput());
    expect(result.ok).toBe(true);
    expect(result.code).toBe(RISK_CODES.PASS);
  });

  it("user+pair limits override global defaults", async () => {
    mockResolve.mockResolvedValue({
      ...defaultLimits,
      max_order_notional_quote: "500.00000000", // user-specific tighter limit
    });

    // notional = 50000 > 500
    const result = await evaluateOrderRisk(mockClient, makeInput());
    expect(result.ok).toBe(false);
    expect(result.code).toBe(RISK_CODES.MAX_NOTIONAL_EXCEEDED);
  });
});
