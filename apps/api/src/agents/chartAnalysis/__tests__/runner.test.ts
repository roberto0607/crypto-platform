/**
 * Chart Analysis Agent runner tests — Anthropic SDK response fully mocked,
 * no real API call. Focus: tool scoping, schema validation on the model's
 * final output (valid and malformed), the proposeChartConfig capture
 * path, numeric grounding of trade parameters in real tool data, and
 * agent_run_logs/trade_proposals writes. Not a test of model output
 * quality — that's not something a mocked unit test can meaningfully
 * assert. Mirrors agents/scanner/__tests__/runner.test.ts's conventions.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

const mockCreate = vi.fn();

// A real class (not vi.fn().mockImplementation) so `new Anthropic(...)`
// in runner.ts always gets a valid constructor regardless of how vitest's
// ESM/CJS interop resolves the SDK's default export.
vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: mockCreate };
  }
  return { default: MockAnthropic };
});

const mockPoolQuery = vi.fn();
vi.mock("../../../db/pool", () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

vi.mock("../../../config", () => ({
  config: { anthropicApiKey: "test-anthropic-key" },
  requireEnv: vi.fn((name: string) => {
    throw new Error(`Missing env var: ${name}`);
  }),
}));

// Recursive factory: any logger.child() call must return another
// logger-shaped object, or transitively-imported modules throw at load.
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

const mockGetNewsForPair = vi.fn();
vi.mock("../../scanner/newsClient", () => ({
  getNewsForPair: (...args: unknown[]) => mockGetNewsForPair(...args),
}));

const mockGetLatestRegimeTag = vi.fn();
vi.mock("../../shared/regimeTagRepo", () => ({
  getLatestRegimeTag: (...args: unknown[]) => mockGetLatestRegimeTag(...args),
}));

const mockComputeIndicatorSnapshot = vi.fn();
const mockGetFundingRateSnapshot = vi.fn();
const mockGetOpenInterestSnapshot = vi.fn();
vi.mock("../../../routes/v1/v1Market", () => ({
  computeIndicatorSnapshot: (...args: unknown[]) => mockComputeIndicatorSnapshot(...args),
  getFundingRateSnapshot: (...args: unknown[]) => mockGetFundingRateSnapshot(...args),
  getOpenInterestSnapshot: (...args: unknown[]) => mockGetOpenInterestSnapshot(...args),
  INDICATOR_KEYS: ["ema20", "ema50", "ema200", "rsi", "atr", "macd", "bollingerBands", "vwap", "delta", "cvd", "vpvr"],
}));

import { runChartAnalysisAgent } from "../runner";
import type { ScannerCandidateData } from "../../../events/eventTypes";

const CANDIDATE: ScannerCandidateData = {
  pairId: "11111111-1111-4111-8111-111111111111",
  symbol: "SOL/USD",
  rank: 1,
  reasoning: "strong volume and volatility",
  regime: "trending",
  supportingDataPoints: ["24h volume 2x average"],
};

function mockMessage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify(VALID_OUTPUT) }],
    model: "claude-haiku-4-5-20251001",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  };
}

const VALID_OUTPUT = {
  timeframe: "1h",
  tradeType: "swing",
  side: "BUY",
  entryPrice: "45000.00",
  stopPrice: "44500.00",
  targetPrice: "46500.00",
  riskRewardRatio: 3,
  confidence: 70,
  entryReason: "current price is 45000.00 per getIndicators",
  stopReason: "stop set 500.00 below entry, one ATR distance",
  targetReason: "target set for a 3:1 risk/reward ratio",
  regime: "trending",
  regimeConfidence: 0.8,
};

beforeEach(() => {
  mockCreate.mockReset();
  mockPoolQuery.mockReset();
  mockPoolQuery.mockImplementation((sql: string) => {
    if (typeof sql === "string" && sql.includes("INSERT INTO trade_proposals")) {
      return Promise.resolve({ rows: [{ id: "proposal-uuid-1" }] });
    }
    return Promise.resolve({ rows: [] }); // agent_run_logs INSERT
  });
  mockGetNewsForPair.mockReset();
  mockGetNewsForPair.mockResolvedValue([]);
  mockGetLatestRegimeTag.mockReset();
  mockGetLatestRegimeTag.mockResolvedValue({ regime: "trending", confidence: "0.8", created_at: "2026-07-31T00:00:00Z" });
  mockComputeIndicatorSnapshot.mockReset();
  mockGetFundingRateSnapshot.mockReset();
  mockGetOpenInterestSnapshot.mockReset();
});

describe("runChartAnalysisAgent — tool scoping", () => {
  it("passes exactly the six allowed tools to the Anthropic SDK call, nothing else", async () => {
    mockCreate.mockResolvedValueOnce(mockMessage());

    await runChartAnalysisAgent(CANDIDATE);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0]![0] as { tools: { name: string }[] };
    const toolNames = callArgs.tools.map((t) => t.name);
    expect(toolNames).toEqual([
      "getIndicators",
      "getFundingRate",
      "getOpenInterest",
      "getNews",
      "getRegimeTag",
      "proposeChartConfig",
    ]);
  });
});

describe("runChartAnalysisAgent — schema validation and trade_proposals write", () => {
  it("writes a valid proposal to trade_proposals with outcome=pending and logs a success row", async () => {
    mockCreate.mockResolvedValueOnce(mockMessage());

    const outcome = await runChartAnalysisAgent(CANDIDATE);

    expect(outcome.error).toBeNull();
    expect(outcome.proposalId).toBe("proposal-uuid-1");

    const insertCall = mockPoolQuery.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO trade_proposals"));
    expect(insertCall).toBeDefined();
    const [sql, params] = insertCall!;
    expect(sql).toContain("outcome");
    expect(sql).toContain("'pending'");
    expect(params[0]).toBe(CANDIDATE.pairId);
    expect(params[1]).toBe("chart-analysis");
    expect(params[9]).toBeNull(); // qty left unsized, agent has no balance context (migration 084)

    const logCall = mockPoolQuery.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO agent_run_logs"));
    expect(logCall).toBeDefined();
    const [, logParams] = logCall!;
    expect(logParams[1]).toBe("success");
  });

  it("does NOT write to trade_proposals for malformed model output -- only logs an error row", async () => {
    mockCreate.mockResolvedValueOnce(mockMessage({ content: [{ type: "text", text: "not json at all" }] }));

    const outcome = await runChartAnalysisAgent(CANDIDATE);

    expect(outcome.proposalId).toBeNull();
    expect(outcome.error).toBe("Model output failed chartAnalysisResult schema validation");

    const insertCall = mockPoolQuery.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO trade_proposals"));
    expect(insertCall).toBeUndefined();

    const logCall = mockPoolQuery.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO agent_run_logs"));
    const [, logParams] = logCall!;
    expect(logParams[1]).toBe("error");
  });

  it("does NOT write to trade_proposals when required fields are missing", async () => {
    const malformed = { timeframe: "1h", side: "BUY" }; // missing tradeType, prices, reasons, confidence
    mockCreate.mockResolvedValueOnce(mockMessage({ content: [{ type: "text", text: JSON.stringify(malformed) }] }));

    const outcome = await runChartAnalysisAgent(CANDIDATE);

    expect(outcome.proposalId).toBeNull();
    expect(outcome.error).toBe("Model output failed chartAnalysisResult schema validation");
  });

  it("does NOT write to trade_proposals when the model emits zero prices (e.g. a 'no data available' run) -- fails schema validation instead", async () => {
    const zeroPriceOutput = {
      ...VALID_OUTPUT,
      entryPrice: "0.00000000",
      stopPrice: "0.00000000",
      targetPrice: "0.00000000",
      stopReason: "Data unavailable; no swing lows, ATR multiples, or support levels can be derived.",
    };
    mockCreate.mockResolvedValueOnce(mockMessage({ content: [{ type: "text", text: JSON.stringify(zeroPriceOutput) }] }));

    const outcome = await runChartAnalysisAgent(CANDIDATE);

    expect(outcome.proposalId).toBeNull();
    expect(outcome.error).toBe("Model output failed chartAnalysisResult schema validation");

    const insertCall = mockPoolQuery.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO trade_proposals"));
    expect(insertCall).toBeUndefined();

    const logCall = mockPoolQuery.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO agent_run_logs"));
    const [, logParams] = logCall!;
    expect(logParams[1]).toBe("error");
  });

  it("accepts explicit regime: null / regimeConfidence: null -- getRegimeTag legitimately returns null when no regime_tags row exists yet", async () => {
    // Mirrors the Scanner Agent's real production failure (2026-07-31):
    // getLatestRegimeTag returns { regime: null, confidence: null } when no
    // regime_tags row exists for the pair, and the model echoes that
    // directly since both fields are marked optional in its JSON template.
    // z.string().optional() / z.number().optional() reject an explicit
    // JSON null (they only tolerate the key being absent), so this used to
    // fail chartAnalysisResult schema validation too, since it derives from
    // tradeProposalSchema and doesn't omit regime/regimeConfidence.
    mockGetLatestRegimeTag.mockResolvedValueOnce({ regime: null, confidence: null, created_at: null });
    const nullRegimeCandidate: ScannerCandidateData = { ...CANDIDATE, regime: null };
    const nullRegimeOutput = { ...VALID_OUTPUT, regime: null, regimeConfidence: null };
    mockCreate.mockResolvedValueOnce(mockMessage({ content: [{ type: "text", text: JSON.stringify(nullRegimeOutput) }] }));

    const outcome = await runChartAnalysisAgent(nullRegimeCandidate);

    expect(outcome.error).toBeNull();
    expect(outcome.proposalId).toBe("proposal-uuid-1");

    const insertCall = mockPoolQuery.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO trade_proposals"));
    const [, params] = insertCall!;
    expect(params[15]).toBeNull(); // regime
    expect(params[16]).toBeNull(); // regime_confidence
  });

  it("handles a preamble/fenced response via the shared defensive JSON parser", async () => {
    const fenced = "Here is my analysis:\n```json\n" + JSON.stringify(VALID_OUTPUT) + "\n```";
    mockCreate.mockResolvedValueOnce(mockMessage({ content: [{ type: "text", text: fenced }] }));

    const outcome = await runChartAnalysisAgent(CANDIDATE);

    expect(outcome.error).toBeNull();
    expect(outcome.proposalId).toBe("proposal-uuid-1");
  });

  it("treats a refusal stop_reason as an error, not a silent empty result", async () => {
    mockCreate.mockResolvedValueOnce(mockMessage({ stop_reason: "refusal", content: [] }));

    const outcome = await runChartAnalysisAgent(CANDIDATE);

    expect(outcome.proposalId).toBeNull();
    expect(outcome.error).toContain("refusal");
  });
});

describe("runChartAnalysisAgent — proposeChartConfig capture", () => {
  it("captures the proposeChartConfig tool call and bundles it into the trade_proposals insert", async () => {
    const chartConfigArgs = { timeframe: "1h", indicators: { ema20: true, rsi: true } };

    mockCreate
      .mockResolvedValueOnce(
        mockMessage({
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "tool_1", name: "proposeChartConfig", input: chartConfigArgs }],
        }),
      )
      .mockResolvedValueOnce(mockMessage());

    const outcome = await runChartAnalysisAgent(CANDIDATE);

    expect(outcome.error).toBeNull();
    const insertCall = mockPoolQuery.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO trade_proposals"));
    const [, params] = insertCall!;
    const chartConfigParam = params[17];
    expect(JSON.parse(chartConfigParam)).toEqual(chartConfigArgs);
  });

  it("stores a null chart_config when the model never calls proposeChartConfig", async () => {
    mockCreate.mockResolvedValueOnce(mockMessage());

    await runChartAnalysisAgent(CANDIDATE);

    const insertCall = mockPoolQuery.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO trade_proposals"));
    const [, params] = insertCall!;
    expect(params[17]).toBeNull();
  });
});

describe("runChartAnalysisAgent — numeric grounding in real tool data", () => {
  it("stores entry/stop numbers and reasoning text that match what the mocked getIndicators call returned, not generic filler", async () => {
    // Simulate a real current price (45210.50) and ATR (312.75) from the
    // tool -- the model's final numbers/reasoning below are built directly
    // from these, not invented.
    mockComputeIndicatorSnapshot.mockResolvedValueOnce({ close: "45210.50", atr: "312.75" });

    const groundedOutput = {
      timeframe: "1h",
      tradeType: "swing",
      side: "BUY",
      entryPrice: "45210.50",
      stopPrice: "44897.75", // 45210.50 - 312.75 (one ATR)
      targetPrice: "46148.75", // entry + 3x stop distance
      riskRewardRatio: 3,
      confidence: 65,
      entryReason: "Entry at 45210.50, the current close from getIndicators.",
      stopReason: "Stop at 44897.75, one ATR (312.75) below entry per getIndicators.",
      targetReason: "Target at 46148.75 for a 3:1 reward relative to the 312.75 stop distance.",
      regime: "trending",
      regimeConfidence: 0.8,
    };

    mockCreate
      .mockResolvedValueOnce(
        mockMessage({
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "getIndicators",
              input: { pairId: CANDIDATE.pairId, timeframe: "1h", indicators: ["atr"] },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(mockMessage({ content: [{ type: "text", text: JSON.stringify(groundedOutput) }] }));

    const outcome = await runChartAnalysisAgent(CANDIDATE);

    expect(outcome.error).toBeNull();
    expect(mockComputeIndicatorSnapshot).toHaveBeenCalledWith(CANDIDATE.pairId, "1h", ["atr"]);

    const insertCall = mockPoolQuery.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO trade_proposals"));
    const [, params] = insertCall!;
    const [, , , , , , entryPrice, stopPrice, , , , , entryReason, stopReason] = params;

    expect(entryPrice).toBe("45210.50");
    expect(stopPrice).toBe("44897.75");
    // Arithmetic sanity: stop distance from entry equals the mocked ATR.
    expect((Number(entryPrice) - Number(stopPrice)).toFixed(2)).toBe("312.75");
    expect(entryReason).toContain("45210.50");
    expect(stopReason).toContain("312.75");
  });
});

describe("runChartAnalysisAgent — server-computed stop distance (migration 085)", () => {
  it("computes stopDistancePct and stopDistanceAtrMultiple from entry/stop prices and the ATR captured during the run", async () => {
    // Same fixture as the numeric-grounding test above: entry 45210.50,
    // stop 44897.75, ATR 312.75 -- the stop is exactly one ATR below
    // entry, so stopDistanceAtrMultiple should come out to exactly 1.
    mockComputeIndicatorSnapshot.mockResolvedValueOnce({ indicators: { atr: 312.75 } });

    const groundedOutput = {
      timeframe: "1h",
      tradeType: "swing",
      side: "BUY",
      entryPrice: "45210.50",
      stopPrice: "44897.75",
      targetPrice: "46148.75",
      riskRewardRatio: 3,
      confidence: 65,
      entryReason: "Entry at 45210.50, the current close from getIndicators.",
      stopReason: "Stop below the recent swing low per getIndicators.",
      targetReason: "Target at 46148.75 for a 3:1 reward relative to the stop distance.",
      regime: "trending",
      regimeConfidence: 0.8,
    };

    mockCreate
      .mockResolvedValueOnce(
        mockMessage({
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "getIndicators",
              input: { pairId: CANDIDATE.pairId, timeframe: "1h", indicators: ["atr"] },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(mockMessage({ content: [{ type: "text", text: JSON.stringify(groundedOutput) }] }));

    const outcome = await runChartAnalysisAgent(CANDIDATE);

    expect(outcome.error).toBeNull();
    const insertCall = mockPoolQuery.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO trade_proposals"));
    const [sql, params] = insertCall!;
    expect(sql).toContain("stop_distance_pct");
    expect(sql).toContain("stop_distance_atr_multiple");
    expect(params[19]).toBeCloseTo(0.006918, 6);
    expect(params[20]).toBeCloseTo(1, 4);
  });

  it("stores stopDistanceAtrMultiple as null when the run never called getIndicators with atr", async () => {
    mockCreate.mockResolvedValueOnce(mockMessage()); // VALID_OUTPUT, no tool calls at all

    const outcome = await runChartAnalysisAgent(CANDIDATE);

    expect(outcome.error).toBeNull();
    const insertCall = mockPoolQuery.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO trade_proposals"));
    const [, params] = insertCall!;
    // VALID_OUTPUT: entryPrice 45000.00, stopPrice 44500.00 -> diff 500.
    expect(params[19]).toBeCloseTo(0.011111, 6);
    expect(params[20]).toBeNull();
  });
});

describe("runChartAnalysisAgent — agent_run_logs, every invocation", () => {
  it("logs an error row when the Anthropic call itself throws", async () => {
    mockCreate.mockRejectedValueOnce(new Error("network error"));

    const outcome = await runChartAnalysisAgent(CANDIDATE);

    expect(outcome.proposalId).toBeNull();
    expect(outcome.error).toBe("network error");
    const logCall = mockPoolQuery.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO agent_run_logs"));
    const [, logParams] = logCall!;
    expect(logParams[1]).toBe("error");
    expect(logParams[4]).toBe("network error");
  });

  it("does not throw when the agent_run_logs write itself fails -- observability can't break the feature it observes", async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (typeof sql === "string" && sql.includes("INSERT INTO agent_run_logs")) {
        return Promise.reject(new Error("db down"));
      }
      return Promise.resolve({ rows: [{ id: "proposal-uuid-1" }] });
    });
    mockCreate.mockResolvedValueOnce(mockMessage());

    const outcome = await runChartAnalysisAgent(CANDIDATE);

    expect(outcome.proposalId).toBe("proposal-uuid-1");
    expect(outcome.error).toBeNull();
  });
});
