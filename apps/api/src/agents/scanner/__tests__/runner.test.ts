/**
 * Scanner Agent runner tests — Anthropic SDK response fully mocked, no
 * real API call. Focus: tool scoping, schema validation on the model's
 * final output (valid and malformed), and agent_run_logs logging/error
 * handling. Not a test of model output quality — that's not something a
 * mocked unit test can meaningfully assert.
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

const mockGetShortlist = vi.fn();
vi.mock("../rank", () => ({
  getShortlist: (...args: unknown[]) => mockGetShortlist(...args),
}));

vi.mock("../../../config", () => ({
  config: { anthropicApiKey: "test-anthropic-key" },
  requireEnv: vi.fn((name: string) => {
    throw new Error(`Missing env var: ${name}`);
  }),
}));

// Recursive factory: any logger.child() call (from transitively-imported
// modules, e.g. v1Market.ts's own dependencies) must return another
// logger-shaped object with the same API, or those imports throw at
// module load. Matches the convention in phase6OrderService.test.ts.
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

import { runScannerAgent } from "../runner";
import type { RankedCandidate } from "../rank";

const SHORTLIST: RankedCandidate[] = [
  { pairId: "11111111-1111-4111-8111-111111111111", symbol: "SOL/USD", volatilityPct: 5, volumeRatio: 2, score: 10 },
  { pairId: "22222222-2222-4222-8222-222222222222", symbol: "LINK/USD", volatilityPct: 3, volumeRatio: 1.5, score: 4.5 },
];

function mockMessage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify({ candidates: [] }) }],
    model: "claude-haiku-4-5-20251001",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  };
}

beforeEach(() => {
  mockCreate.mockReset();
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [] }); // default: agent_run_logs INSERT succeeds
  mockGetShortlist.mockReset();
  mockGetShortlist.mockResolvedValue(SHORTLIST);
});

describe("runScannerAgent — tool scoping", () => {
  it("passes exactly the five read-only tools to the Anthropic SDK call, nothing else", async () => {
    mockCreate.mockResolvedValueOnce(
      mockMessage({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              candidates: [
                { pairId: SHORTLIST[0]!.pairId, symbol: "SOL/USD", rank: 1, reasoning: "strong volume", supportingDataPoints: [] },
              ],
            }),
          },
        ],
      }),
    );

    await runScannerAgent();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0]![0] as { tools: { name: string }[] };
    const toolNames = callArgs.tools.map((t) => t.name);
    expect(toolNames).toEqual(["getIndicators", "getFundingRate", "getOpenInterest", "getNews", "getRegimeTag"]);
  });
});

describe("runScannerAgent — schema validation on model output", () => {
  it("returns a valid parsed result and logs a success row for well-formed JSON", async () => {
    const validPayload = {
      candidates: [
        { pairId: SHORTLIST[0]!.pairId, symbol: "SOL/USD", rank: 1, reasoning: "strong volume and volatility", supportingDataPoints: ["24h volume 2x average"] },
      ],
    };
    mockCreate.mockResolvedValueOnce(mockMessage({ content: [{ type: "text", text: JSON.stringify(validPayload) }] }));

    const outcome = await runScannerAgent();

    expect(outcome.error).toBeNull();
    expect(outcome.result).toEqual(validPayload);

    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPoolQuery.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO agent_run_logs");
    expect(params[1]).toBe("success"); // status
    expect(params[4]).toBeNull(); // error
  });

  it("does NOT pass a malformed candidate downstream -- invalid JSON logs an error row", async () => {
    mockCreate.mockResolvedValueOnce(mockMessage({ content: [{ type: "text", text: "this is not json" }] }));

    const outcome = await runScannerAgent();

    expect(outcome.result).toBeNull();
    expect(outcome.error).toBe("Model output failed scannerResult schema validation");

    const [sql, params] = mockPoolQuery.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO agent_run_logs");
    expect(params[1]).toBe("error");
    expect(params[4]).toBe("Model output failed scannerResult schema validation");
  });

  it("does NOT pass a malformed candidate downstream -- valid JSON that violates the schema logs an error row", async () => {
    // Missing required fields (reasoning, rank) and a non-UUID pairId.
    const malformed = { candidates: [{ pairId: "not-a-uuid", symbol: "SOL/USD" }] };
    mockCreate.mockResolvedValueOnce(mockMessage({ content: [{ type: "text", text: JSON.stringify(malformed) }] }));

    const outcome = await runScannerAgent();

    expect(outcome.result).toBeNull();
    expect(outcome.error).toBe("Model output failed scannerResult schema validation");
  });

  it("treats a refusal stop_reason as an error, not a silent empty result", async () => {
    mockCreate.mockResolvedValueOnce(mockMessage({ stop_reason: "refusal", content: [] }));

    const outcome = await runScannerAgent();

    expect(outcome.result).toBeNull();
    expect(outcome.error).toContain("refusal");
    const [, params] = mockPoolQuery.mock.calls[0]!;
    expect(params[1]).toBe("error");
  });
});

describe("runScannerAgent — agent_run_logs, every invocation", () => {
  it("logs a row even when the shortlist is empty (never calls the model)", async () => {
    mockGetShortlist.mockResolvedValueOnce([]);

    const outcome = await runScannerAgent();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(outcome.result).toEqual({ candidates: [] });
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPoolQuery.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO agent_run_logs");
    expect(params[1]).toBe("success");
  });

  it("logs an error row when the Anthropic call itself throws", async () => {
    mockCreate.mockRejectedValueOnce(new Error("network error"));

    const outcome = await runScannerAgent();

    expect(outcome.result).toBeNull();
    expect(outcome.error).toBe("network error");
    const [, params] = mockPoolQuery.mock.calls[0]!;
    expect(params[1]).toBe("error");
    expect(params[4]).toBe("network error");
  });

  it("does not throw when the agent_run_logs write itself fails -- observability can't break the feature it observes", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("db down"));
    mockCreate.mockResolvedValueOnce(
      mockMessage({ content: [{ type: "text", text: JSON.stringify({ candidates: [] }) }] }),
    );

    const outcome = await runScannerAgent();

    // The scan itself still succeeded -- only the logging call failed, and
    // that failure was swallowed (caught + logged, not rethrown).
    expect(outcome.result).toEqual({ candidates: [] });
    expect(outcome.error).toBeNull();
  });
});
