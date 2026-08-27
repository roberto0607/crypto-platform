/**
 * newsAgentJob.test.ts -- unit tests for the News Agent (Gate 1f)
 * periodic job. pool/config/getShortlist are module-mocked (same "mock
 * the DB boundary" convention as executeTradeProposal.test.ts/
 * scannerAgentJob.test.ts); global fetch is stubbed per-test via
 * vi.stubGlobal, routed by URL substring to the two real APITube
 * endpoints this job calls (/v1/suggest/entities, /v1/news/everything).
 *
 * IMPORTANT test-design note: newsAgentJob.ts's entityIdCache is a
 * MODULE-LEVEL Map, not exported and not reset between tests -- the
 * module is imported once for this whole file, so a pairId resolved in
 * one test stays cached for every test after it. Cache-hit behavior is
 * therefore tested by calling run() TWICE within a single test (not by
 * comparing across two different tests), and every other test uses its
 * own never-reused pairId constant so it can never accidentally read a
 * cache entry left behind by an earlier test.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { JobContext } from "../../jobTypes";

const mockConfig = vi.hoisted(() => ({
  newsAgentEnabled: true,
  newsApiKey: "test-api-key",
}));
vi.mock("../../../config", () => ({ config: mockConfig }));

const mockPoolQuery = vi.fn();
vi.mock("../../../db/pool", () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

const mockGetShortlist = vi.fn();
vi.mock("../../../agents/scanner/rank", () => ({
  getShortlist: (...args: unknown[]) => mockGetShortlist(...args),
}));

import { newsAgentJob } from "../newsAgentJob";

const mockFetch = vi.fn();
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function fakeCtx(): JobContext {
  return {
    pool: {} as JobContext["pool"],
    logger: mockLogger as unknown as JobContext["logger"],
    signal: new AbortController().signal,
  };
}

function shortlistCandidate(pairId: string, symbol = "TEST/USD") {
  return { pairId, symbol, volatilityPct: 1, volumeRatio: 1, score: 1 };
}

/** Wires mockPoolQuery to answer the trading_pairs/assets name-lookup
 *  join with the given rows; any other query (the upsert) resolves
 *  {rows:[]} and is captured via mockPoolQuery.mock.calls for
 *  assertions instead. */
function setupPool(assetNameRows: Array<{ pair_id: string; name: string }>) {
  mockPoolQuery.mockImplementation((sql: string) => {
    if (typeof sql === "string" && sql.includes("FROM trading_pairs p") && sql.includes("JOIN assets")) {
      return Promise.resolve({ rows: assetNameRows });
    }
    return Promise.resolve({ rows: [] });
  });
}

function fakeResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, statusText: ok ? "OK" : "Error", json: async () => body } as Response;
}

/** Maps asset name -> APITube numeric entity id for a /v1/suggest/entities response, read off the `name=` query param. */
function suggestEntitiesResponder(nameToEntityId: Record<string, number>) {
  return (url: string) => {
    const match = /name=([^&]+)/.exec(url);
    const name = match ? decodeURIComponent(match[1]!) : "";
    const id = nameToEntityId[name];
    if (id === undefined) throw new Error(`test setup error: no entity id configured for asset name "${name}"`);
    return fakeResponse({ results: [{ id, name, type: "brand" }] });
  };
}

function upsertCalls() {
  return mockPoolQuery.mock.calls.filter(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO pair_news_flags"));
}

const PAIR_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const PAIR_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const PAIR_C = "cccccccc-0000-4000-8000-00000000000c";
const PAIR_D = "dddddddd-0000-4000-8000-00000000000d";
const PAIR_E = "eeeeeeee-0000-4000-8000-00000000000e";
const PAIR_F = "ffffffff-0000-4000-8000-00000000000f";
const PAIR_G = "11111111-0000-4000-8000-000000000001";
const PAIR_H = "22222222-0000-4000-8000-000000000002";
const PAIR_NOMATCH = "33333333-0000-4000-8000-000000000003";
const PAIR_NEG = "44444444-0000-4000-8000-000000000004";
const PAIR_MILD_NEG = "55555555-0000-4000-8000-000000000005";
const PAIR_POS = "66666666-0000-4000-8000-000000000006";
const PAIR_NEUTRAL = "77777777-0000-4000-8000-000000000007";
const PAIR_BOUNDARY = "88888888-0000-4000-8000-000000000008";

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
  mockPoolQuery.mockReset();
  mockGetShortlist.mockReset();
  mockGetShortlist.mockResolvedValue([]);
  mockConfig.newsAgentEnabled = true;
  mockConfig.newsApiKey = "test-api-key";
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("newsAgentJob — missing-key / disabled guards", () => {
  it("warns news_agent_no_api_key and returns without any DB or fetch call when config.newsApiKey is empty", async () => {
    mockConfig.newsApiKey = "";

    await newsAgentJob.run(fakeCtx());

    expect(mockLogger.warn).toHaveBeenCalledWith("news_agent_no_api_key");
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockGetShortlist).not.toHaveBeenCalled();
  });

  it("warns again on a second consecutive run while the key is still missing -- proves 'every cycle', not warn-once", async () => {
    mockConfig.newsApiKey = "";

    await newsAgentJob.run(fakeCtx());
    await newsAgentJob.run(fakeCtx());

    const warnCalls = mockLogger.warn.mock.calls.filter(([msg]) => msg === "news_agent_no_api_key");
    expect(warnCalls).toHaveLength(2);
  });

  it("does nothing at all -- no warn, no DB call, no fetch -- when config.newsAgentEnabled is false, even with a real key configured", async () => {
    mockConfig.newsAgentEnabled = false;
    mockConfig.newsApiKey = "real-key";

    await newsAgentJob.run(fakeCtx());

    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("newsAgentJob — entity-ID resolution: cache and retry behavior", () => {
  it("resolves an unresolved pair via /v1/suggest/entities on the first run, then reuses the cached id on a second run without calling suggest/entities again", async () => {
    mockGetShortlist.mockResolvedValue([shortlistCandidate(PAIR_A, "A/USD")]);
    setupPool([{ pair_id: PAIR_A, name: "CacheCoinA" }]);
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/suggest/entities")) return suggestEntitiesResponder({ CacheCoinA: 501 })(url);
      if (url.includes("/news/everything")) return fakeResponse({ results: [] });
      throw new Error(`unexpected url: ${url}`);
    });

    await newsAgentJob.run(fakeCtx());
    await newsAgentJob.run(fakeCtx());

    const suggestCalls = mockFetch.mock.calls.filter(([url]) => typeof url === "string" && url.includes("/suggest/entities"));
    const newsCalls = mockFetch.mock.calls.filter(([url]) => typeof url === "string" && url.includes("/news/everything"));
    expect(suggestCalls).toHaveLength(1); // resolved once, cached, never re-resolved
    expect(newsCalls).toHaveLength(2); // the batch fetch itself is NOT cached -- one per run
  });

  it("does not cache a failed resolution (suggest/entities call throws) -- the next run retries the same pair instead of permanently skipping it", async () => {
    mockGetShortlist.mockResolvedValue([shortlistCandidate(PAIR_B, "B/USD")]);
    setupPool([{ pair_id: PAIR_B, name: "RetryCoinB" }]);

    let suggestCallCount = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/suggest/entities")) {
        suggestCallCount++;
        if (suggestCallCount === 1) throw new Error("network_down");
        return suggestEntitiesResponder({ RetryCoinB: 502 })(url);
      }
      if (url.includes("/news/everything")) return fakeResponse({ results: [] });
      throw new Error(`unexpected url: ${url}`);
    });

    await newsAgentJob.run(fakeCtx());
    expect(upsertCalls()).toHaveLength(0); // resolution failed -- pair skipped entirely, no upsert
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ assetName: "RetryCoinB" }),
      "news_agent_entity_resolution_failed",
    );

    await newsAgentJob.run(fakeCtx());
    expect(suggestCallCount).toBe(2); // proves the second run genuinely re-attempted resolution, not "cached as failed"
    expect(upsertCalls()).toHaveLength(1);
    expect(upsertCalls()[0]![1]).toEqual(expect.arrayContaining([PAIR_B]));
  });

  it("does not cache a no-match resolution (empty results array) -- the next run retries", async () => {
    mockGetShortlist.mockResolvedValue([shortlistCandidate(PAIR_NOMATCH, "NM/USD")]);
    setupPool([{ pair_id: PAIR_NOMATCH, name: "NoMatchCoin" }]);

    let suggestCallCount = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/suggest/entities")) {
        suggestCallCount++;
        if (suggestCallCount === 1) return fakeResponse({ results: [] }); // no match first time
        return suggestEntitiesResponder({ NoMatchCoin: 503 })(url);
      }
      if (url.includes("/news/everything")) return fakeResponse({ results: [] });
      throw new Error(`unexpected url: ${url}`);
    });

    await newsAgentJob.run(fakeCtx());
    expect(upsertCalls()).toHaveLength(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ assetName: "NoMatchCoin" }),
      "news_agent_entity_resolution_no_match",
    );

    await newsAgentJob.run(fakeCtx());
    expect(suggestCallCount).toBe(2);
    expect(upsertCalls()).toHaveLength(1);
  });
});

describe("newsAgentJob — batch fetch: failure vs. genuine empty result", () => {
  it("a batch whose fetch throws leaves that batch's pairs' existing pair_news_flags rows untouched -- no upsert SQL issued for those pairs", async () => {
    mockGetShortlist.mockResolvedValue([shortlistCandidate(PAIR_C, "C/USD")]);
    setupPool([{ pair_id: PAIR_C, name: "FailCoinC" }]);
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/suggest/entities")) return suggestEntitiesResponder({ FailCoinC: 504 })(url);
      if (url.includes("/news/everything")) throw new Error("apitube_down");
      throw new Error(`unexpected url: ${url}`);
    });

    await newsAgentJob.run(fakeCtx());

    expect(upsertCalls()).toHaveLength(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pairIds: [PAIR_C] }),
      "news_agent_batch_fetch_failed",
    );
  });

  it("a batch that succeeds but finds no matching article for a pair writes an explicit flagged_negative=false row -- not a skipped upsert", async () => {
    mockGetShortlist.mockResolvedValue([shortlistCandidate(PAIR_D, "D/USD")]);
    setupPool([{ pair_id: PAIR_D, name: "QuietCoinD" }]);
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/suggest/entities")) return suggestEntitiesResponder({ QuietCoinD: 505 })(url);
      if (url.includes("/news/everything")) return fakeResponse({ results: [] }); // no articles at all this cycle
      throw new Error(`unexpected url: ${url}`);
    });

    await newsAgentJob.run(fakeCtx());

    const calls = upsertCalls();
    expect(calls).toHaveLength(1);
    const params = calls[0]![1] as unknown[];
    // INSERT column order: pair_id, flagged_negative, reason, source_headline, expires_at
    expect(params[0]).toBe(PAIR_D);
    expect(params[1]).toBe(false);
    expect(params[2]).toBeNull();
    expect(params[3]).toBeNull();
  });

  it("one batch failing does not prevent a different, independent batch from being upserted in the same run", async () => {
    // ENTITY_BATCH_SIZE=3 -> [PAIR_E, PAIR_F, PAIR_G] is batch 1, [PAIR_H] is batch 2.
    const pairs = [PAIR_E, PAIR_F, PAIR_G, PAIR_H];
    const names = ["CoinE", "CoinF", "CoinG", "CoinH"];
    mockGetShortlist.mockResolvedValue(pairs.map((id, i) => shortlistCandidate(id, names[i])));
    setupPool(pairs.map((id, i) => ({ pair_id: id, name: names[i]! })));

    const nameToEntityId = Object.fromEntries(names.map((n, i) => [n, 600 + i]));
    let newsCallCount = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/suggest/entities")) return suggestEntitiesResponder(nameToEntityId)(url);
      if (url.includes("/news/everything")) {
        newsCallCount++;
        if (newsCallCount === 1) throw new Error("first_batch_down"); // batch [E,F,G]
        return fakeResponse({ results: [] }); // batch [H]
      }
      throw new Error(`unexpected url: ${url}`);
    });

    await newsAgentJob.run(fakeCtx());

    expect(newsCallCount).toBe(2); // both batches were attempted
    const calls = upsertCalls();
    expect(calls).toHaveLength(1); // only the second batch's pair got upserted
    expect(calls[0]![1]).toEqual(expect.arrayContaining([PAIR_H]));
  });
});

describe("newsAgentJob — sentiment threshold logic", () => {
  function singlePairArticleTest(
    pairId: string,
    assetName: string,
    entityId: number,
    sentiment: { score: number; polarity: string },
    title = "Some headline",
  ) {
    mockGetShortlist.mockResolvedValue([shortlistCandidate(pairId, `${assetName}/USD`)]);
    setupPool([{ pair_id: pairId, name: assetName }]);
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/suggest/entities")) return suggestEntitiesResponder({ [assetName]: entityId })(url);
      if (url.includes("/news/everything")) {
        return fakeResponse({
          results: [
            {
              title,
              published_at: "2026-08-27T00:00:00Z",
              entities: [{ id: entityId, name: assetName, type: "brand" }],
              sentiment: { overall: sentiment },
            },
          ],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    return newsAgentJob.run(fakeCtx());
  }

  it("polarity='negative' AND score <= -0.3 -> flags the pair, reason string references the polarity and score", async () => {
    await singlePairArticleTest(PAIR_NEG, "NegCoin", 900, { score: -0.8, polarity: "negative" }, "NegCoin exchange hacked, funds drained");

    const params = upsertCalls()[0]![1] as unknown[];
    expect(params[1]).toBe(true);
    expect(params[2]).toContain("polarity=negative");
    expect(params[2]).toContain("score=-0.80");
    expect(params[3]).toBe("NegCoin exchange hacked, funds drained");
  });

  it("polarity='negative' but score above -0.3 (e.g. -0.1) -> does NOT flag", async () => {
    await singlePairArticleTest(PAIR_MILD_NEG, "MildCoin", 901, { score: -0.1, polarity: "negative" });

    const params = upsertCalls()[0]![1] as unknown[];
    expect(params[1]).toBe(false);
    expect(params[2]).toBeNull();
  });

  it("polarity='positive' regardless of score -> does NOT flag", async () => {
    // score is deliberately extreme-negative to prove polarity alone can veto -- a
    // negative score with positive polarity must NOT flag (both conditions required).
    await singlePairArticleTest(PAIR_POS, "PosCoin", 902, { score: -0.9, polarity: "positive" });

    const params = upsertCalls()[0]![1] as unknown[];
    expect(params[1]).toBe(false);
  });

  it("polarity='neutral' regardless of score -> does NOT flag", async () => {
    await singlePairArticleTest(PAIR_NEUTRAL, "NeutralCoin", 903, { score: -0.9, polarity: "neutral" });

    const params = upsertCalls()[0]![1] as unknown[];
    expect(params[1]).toBe(false);
  });

  it("score exactly at the threshold (-0.3) -> flags (inclusive boundary, matches score <= threshold)", async () => {
    await singlePairArticleTest(PAIR_BOUNDARY, "BoundaryCoin", 904, { score: -0.3, polarity: "negative" });

    const params = upsertCalls()[0]![1] as unknown[];
    expect(params[1]).toBe(true);
  });
});
