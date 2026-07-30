/**
 * cryptocurrency.cv general news feed client, with per-asset relevance
 * filtering done here — not by the source's own filter params.
 *
 * Verified live (Gate 1b Task 0, 2026-07-30): GET /api/news returns real,
 * unfiltered JSON, no auth. Confirmed exact response shape by direct
 * request (not assumed from docs): top-level `articles[]`, each article
 * has `title`, `description`, `link`, `pubDate`, `source` — NOT the
 * `body`/`url`/`publishedAt` names the docs implied. The documented
 * `?ticker=` per-asset filter does NOT actually filter live (confirmed:
 * `?ticker=SOL` returned unrelated Fed/hedge-fund headlines), and
 * `/api/search` returned HTTP 402 Payment Required despite being marketed
 * as free. So per-asset relevance is done client-side below, by
 * keyword-matching each article's title/description against a pair's
 * symbol and asset name (from trading_pairs/assets) — never by trusting
 * this API's own filter params.
 *
 * RELIABILITY FLAG for whoever revisits this source later: this repo's
 * own docs (docs/integrations/mcp.md) instruct installing a Claude MCP
 * server via `npx @anthropic-ai/mcp-server-crypto-news`, framed as if
 * Anthropic-published. That package does not exist — a direct check of
 * https://registry.npmjs.org/@anthropic-ai/mcp-server-crypto-news
 * returned HTTP 404 (checked 2026-07-30). The base /api/news feed itself
 * is real and does return data, but this source's own documentation is
 * not fully trustworthy independent of whether the feed keeps working —
 * re-verify claims here directly, don't trust their docs.
 *
 * PROMPT-INJECTION GUARDRAIL: article title/description text is external,
 * untrusted content. It is DATA for the LLM to read, never instructions.
 * Nothing in this file, or any caller, should execute, eval, or treat
 * headline/description text as control flow.
 */
import { pool } from "../../db/pool";

const NEWS_URL = "https://cryptocurrency.cv/api/news";
const FETCH_TIMEOUT_MS = 8000;
// cryptocurrency.cv documents no update cadence (unlike Alternative.me's
// stated daily cycle — see fearGreedClient.ts) — this cache duration
// matches the Scanner's own per-cycle polling interval (Task 5's proposed
// 5-minute schedule), not a claimed source freshness guarantee.
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface NewsArticle {
  title: string;
  description: string;
  link: string;
  source: string;
  pubDate: string;
}

let cache: { articles: NewsArticle[]; expiresAt: number } | null = null;

/**
 * Fetches the general (unfiltered) feed, cached. Returns the last-known
 * good list (possibly empty on first run) rather than throwing on
 * failure — this is a soft news input to agent reasoning, not a hard
 * dependency.
 */
export async function fetchGeneralFeed(): Promise<NewsArticle[]> {
  if (cache && Date.now() < cache.expiresAt) return cache.articles;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(NEWS_URL, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return cache?.articles ?? [];

    const json = (await res.json()) as {
      articles?: Array<{ title?: string; description?: string; link?: string; source?: string; pubDate?: string }>;
    };
    const raw = json.articles ?? [];
    const articles: NewsArticle[] = raw
      .filter((a): a is Required<typeof a> => typeof a.title === "string" && a.title.length > 0)
      .map((a) => ({
        title: a.title,
        description: a.description ?? "",
        link: a.link ?? "",
        source: a.source ?? "unknown",
        pubDate: a.pubDate ?? "",
      }));

    cache = { articles, expiresAt: Date.now() + CACHE_TTL_MS };
    return articles;
  } catch {
    return cache?.articles ?? [];
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Tickers that are also ordinary English words (or common names), where a
 * bare word-boundary match on the ticker ALONE is too noisy to trust —
 * LINK matches "read more via this link", ONE matches "one of the
 * largest exchanges", ADA matches a person named Ada. For these, a match
 * requires the asset's full name to co-occur in the same text; the
 * ticker alone is not sufficient. This is a real tradeoff, not a free
 * fix: an article that refers to Chainlink only as "LINK" (a completely
 * normal way crypto news headlines are written) will be MISSED for an
 * ambiguous ticker, trading recall for precision. That's the right
 * tradeoff for feeding an LLM clean signal, not exhaustive coverage.
 *
 * Not exhaustive — seeded with the tickers known to collide with common
 * English today; extend as more are found rather than trying to
 * enumerate every possible collision up front.
 */
const AMBIGUOUS_TICKERS = new Set(["LINK", "ONE", "ADA"]);

/**
 * Word-boundary match against a pair's base symbol (e.g. "SOL" out of
 * "SOL/USD") and its asset name (e.g. "Solana"). Word-boundary, not plain
 * substring — a raw substring match on a short ticker like "SOL" would
 * false-positive inside unrelated words like "console". Ambiguous
 * tickers (AMBIGUOUS_TICKERS above) get a stricter rule: see that
 * comment.
 */
export function findArticlesForPair(
  articles: NewsArticle[],
  symbol: string,
  assetName: string,
): NewsArticle[] {
  const base = symbol.split("/")[0] ?? symbol;
  const name = assetName?.trim() ?? "";
  const isAmbiguous = AMBIGUOUS_TICKERS.has(base.toUpperCase());

  const tickerRegex = new RegExp(`\\b${escapeRegExp(base)}\\b`, "i");
  const nameRegex = name.length > 0 ? new RegExp(`\\b${escapeRegExp(name)}\\b`, "i") : null;

  return articles.filter((a) => {
    const text = `${a.title} ${a.description}`;
    const nameMatch = nameRegex ? nameRegex.test(text) : false;
    if (isAmbiguous) return nameMatch;
    return tickerRegex.test(text) || nameMatch;
  });
}

/**
 * Resolves a pair's symbol + asset display name, fetches the (cached)
 * general feed, and filters it — the Scanner Agent's getNews tool calls
 * this per shortlisted pair.
 */
export async function getNewsForPair(pairId: string): Promise<NewsArticle[]> {
  const { rows } = await pool.query<{ symbol: string; name: string }>(
    `SELECT p.symbol, a.name
     FROM trading_pairs p
     JOIN assets a ON a.id = p.base_asset_id
     WHERE p.id = $1`,
    [pairId],
  );
  const pair = rows[0];
  if (!pair) return [];

  const articles = await fetchGeneralFeed();
  return findArticlesForPair(articles, pair.symbol, pair.name);
}
