import { describe, it, expect } from "vitest";
import { findArticlesForPair, type NewsArticle } from "../newsClient";

function article(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    title: "Some headline",
    description: "Some body text",
    link: "https://example.com/a",
    source: "example",
    pubDate: "2026-07-30T00:00:00Z",
    ...overrides,
  };
}

describe("findArticlesForPair", () => {
  it("matches on the base symbol as a whole word in the title", () => {
    const articles = [article({ title: "SOL rallies 12% on new network upgrade" })];
    const result = findArticlesForPair(articles, "SOL/USD", "Solana");
    expect(result).toHaveLength(1);
  });

  it("matches on the asset name when the symbol isn't mentioned", () => {
    const articles = [article({ title: "Solana Labs announces partnership", description: "" })];
    const result = findArticlesForPair(articles, "SOL/USD", "Solana");
    expect(result).toHaveLength(1);
  });

  it("matches in the description, not just the title", () => {
    const articles = [article({ title: "Market roundup", description: "SOL led gains today" })];
    const result = findArticlesForPair(articles, "SOL/USD", "Solana");
    expect(result).toHaveLength(1);
  });

  it("does not match a short ticker as a substring inside an unrelated word", () => {
    // "SOL" must not match inside "console" or "isolated" -- word-boundary only.
    const articles = [
      article({ title: "Developers debug the console output", description: "" }),
      article({ title: "Markets remain isolated from macro moves", description: "" }),
    ];
    const result = findArticlesForPair(articles, "SOL/USD", "Solana");
    expect(result).toHaveLength(0);
  });

  it("is case-insensitive", () => {
    const articles = [article({ title: "sol surges on low volume", description: "" })];
    const result = findArticlesForPair(articles, "SOL/USD", "Solana");
    expect(result).toHaveLength(1);
  });

  it("excludes articles that mention neither the symbol nor the name", () => {
    const articles = [article({ title: "Fed holds rates steady", description: "BNPL services under scrutiny" })];
    const result = findArticlesForPair(articles, "SOL/USD", "Solana");
    expect(result).toHaveLength(0);
  });

  it("returns an empty array when given no articles", () => {
    expect(findArticlesForPair([], "SOL/USD", "Solana")).toEqual([]);
  });

  it("does not match an ambiguous ticker (LINK) used as an ordinary English word", () => {
    const articles = [article({ title: "Click this link to read more", description: "" })];
    const result = findArticlesForPair(articles, "LINK/USD", "Chainlink");
    expect(result).toHaveLength(0);
  });

  it("does not match an ambiguous ticker (ONE) used as an ordinary English word", () => {
    const articles = [article({ title: "Binance is one of the largest exchanges", description: "" })];
    const result = findArticlesForPair(articles, "ONE/USD", "Harmony");
    expect(result).toHaveLength(0);
  });

  it("does not match an ambiguous ticker (ADA) used as a person's name", () => {
    const articles = [article({ title: "Ada Lovelace exhibit opens at the museum", description: "" })];
    const result = findArticlesForPair(articles, "ADA/USD", "Cardano");
    expect(result).toHaveLength(0);
  });

  it("matches an ambiguous ticker's article when the full asset name co-occurs", () => {
    const articles = [article({ title: "Chainlink announces new oracle partnership", description: "" })];
    const result = findArticlesForPair(articles, "LINK/USD", "Chainlink");
    expect(result).toHaveLength(1);
  });

  it("documents the tradeoff: an ambiguous ticker mentioned WITHOUT the full name is missed", () => {
    // This is the deliberate precision-over-recall tradeoff, not a bug --
    // see the AMBIGUOUS_TICKERS comment in newsClient.ts.
    const articles = [article({ title: "LINK breaks key resistance level", description: "" })];
    const result = findArticlesForPair(articles, "LINK/USD", "Chainlink");
    expect(result).toHaveLength(0);
  });

  it("filters a mixed list down to only the matching articles", () => {
    const articles = [
      article({ title: "SOL breaks resistance", description: "" }),
      article({ title: "BTC consolidates near highs", description: "" }),
      article({ title: "Solana ecosystem TVL grows", description: "" }),
    ];
    const result = findArticlesForPair(articles, "SOL/USD", "Solana");
    expect(result).toHaveLength(2);
  });
});
