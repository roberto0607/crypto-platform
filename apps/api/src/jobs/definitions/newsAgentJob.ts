/**
 * News Agent (Gate 1f) -- periodic job that resolves the Scanner Agent's
 * current pair shortlist to APITube entity IDs, fetches recent
 * sentiment-scored news for each shortlisted pair, and upserts a
 * flagged_negative cache row per pair. Execution Agent's runPhase1 reads
 * this table synchronously (fast local SELECT) as a pre-execution safety
 * gate -- see the design lock recon: this job's ONLY purpose is to keep
 * pair_news_flags fresh enough for that gate to trust; it can only ever
 * cause a trade to be BLOCKED, never approved (deterministic, no LLM,
 * mirrors the stale-price guard in executor.ts).
 *
 * Pair scope: NOT all ~137 active trading_pairs -- getShortlist() (same
 * function Scanner Agent uses, pure arithmetic, no LLM/API-key
 * dependency) bounds this to the ~8 pairs a trade_proposal could ever
 * actually exist for (chartAnalysisEngine.ts only ever processes
 * scanner.result's shortlist candidates). Checking pairs outside that
 * shortlist would be wasted quota on pairs Execution Agent can never see
 * a proposal for.
 *
 * Entity resolution: APITube's `entities[]` on an article have NO
 * ticker/symbol field (entity.type is person|location|organization|
 * brand|product|natural-disaster|disease|event|sport|unknown) -- so a
 * pair's base asset NAME (e.g. "Bitcoin", not "BTC") is resolved to a
 * stable numeric entity.id via /v1/suggest/entities once, then cached
 * indefinitely in-process (module-level Map, not persisted -- disposable
 * derived data, cheap to rebuild on restart) since an asset's real-world
 * entity identity doesn't change run to run. A resolution that fails or
 * returns no match is deliberately NOT cached, so the next cycle retries
 * it instead of permanently giving up on that pair. NOTE: the exact
 * query param name for /v1/suggest/entities (`name` below) is a
 * best-inference from APITube's docs describing it only as "autocomplete
 * search by name prefix" -- their parameter-reference page for this
 * specific endpoint 404'd on direct check. If wrong, every resolution
 * fails the same way and logs loudly (news_agent_entity_resolution_no_match)
 * rather than silently matching the wrong entity.
 *
 * Quota: entity.id accepts up to 3 comma-separated IDs per request (OR
 * logic) -- confirmed against APITube's filter-pattern docs and their own
 * entity-query examples (no example anywhere exceeds 3 IDs). 8
 * shortlisted pairs -> ceil(8/3) = 3 requests/cycle. At this job's
 * 10-minute interval: 3 * 144 = 432 requests/day, within the account's
 * confirmed 1,000/day plan.
 *
 * Freshness: every run writes a fresh row for every shortlisted pair
 * whose batch fetch succeeded, INCLUDING an explicit un-flag
 * (flagged_negative=false) when no negative news was found this cycle --
 * relying on expires_at alone to age out a stale TRUE flag would mean a
 * pair that's already turned neutral stays reported as flagged for up to
 * the full expiry window even though this job already re-checked and
 * knows better. expires_at is a pure staleness/trust bound for when the
 * JOB ITSELF stops running (see the Gate 1f staleness watchdog), not a
 * substitute for re-checking. A batch whose fetch call itself fails is
 * handled differently -- see fetchBatchFlags below: its pairs' existing
 * rows are left untouched, never overwritten with a fabricated "checked,
 * all clear."
 */
import { pool } from "../../db/pool";
import type { JobDefinition, JobContext } from "../jobTypes";
import { config } from "../../config";
import { getShortlist } from "../../agents/scanner/rank";

const APITUBE_BASE_URL = "https://api.apitube.io/v1";
const FETCH_TIMEOUT_MS = 8000;
// APITube entity.id comma-separated OR cap, confirmed against their docs
// (news-api-filter-patterns) and corroborated by every multi-ID example
// in their own entity-query-examples page topping out at 3.
const ENTITY_BATCH_SIZE = 3;
// Midpoint of the 30-60min range set in the design lock.
const FLAG_EXPIRES_MINUTES = 45;

// Sentiment threshold for flagging a pair negative. Polarity alone
// ("negative") is too coarse by itself -- a headline whose score barely
// tips negative (e.g. -0.05) would trip the same flag as a genuinely bad
// one (-0.8), and since this gate can only ever DELAY a trade (the
// proposal isn't lost -- Chart Analysis can re-propose next scan cycle,
// same recoverability as a tolerance_exceeded rejection in executor.ts),
// a moderate false-positive rate from routine market-recap noise is
// worse than occasionally missing a borderline-negative story. Requiring
// BOTH polarity === "negative" AND score <= this threshold targets
// headlines that are unambiguously and materially negative, not noise
// near zero.
const NEGATIVE_SCORE_THRESHOLD = -0.3;

// Module-level, in-process cache: pairId -> APITube numeric entity.id.
// See file header for why this is indefinite/not DB-persisted and why a
// failed resolution is never cached.
const entityIdCache = new Map<string, number>();

interface ApiTubeEntity {
  id: number;
  name?: string;
  type?: string;
}

interface ApiTubeArticle {
  title?: string;
  published_at?: string;
  entities?: ApiTubeEntity[];
  sentiment?: {
    overall?: {
      score?: number;
      polarity?: string;
    };
  };
}

interface PairFlag {
  flagged: boolean;
  reason: string | null;
  headline: string | null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "X-API-Key": config.newsApiKey },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`APITube request failed: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function resolveEntityId(assetName: string, ctx: JobContext): Promise<number | null> {
  try {
    const url = `${APITUBE_BASE_URL}/suggest/entities?name=${encodeURIComponent(assetName)}`;
    const json = await fetchJson(url);
    const results = (json as { results?: ApiTubeEntity[] } | null)?.results;
    const first = Array.isArray(results) ? results[0] : undefined;
    if (!first || typeof first.id !== "number") {
      ctx.logger.warn({ assetName }, "news_agent_entity_resolution_no_match");
      return null;
    }
    return first.id;
  } catch (err) {
    ctx.logger.warn({ assetName, err }, "news_agent_entity_resolution_failed");
    return null;
  }
}

/**
 * Resolves every shortlisted pair not already in entityIdCache, then
 * returns { pairId, entityId } for every pair currently resolved
 * (cache hits from prior runs + any newly resolved this run). Pairs that
 * fail to resolve are simply absent from the result -- there's no flag
 * to fetch for them this cycle, and their existing pair_news_flags row
 * (if any) is left untouched, same as a failed batch fetch.
 */
async function resolveShortlistEntities(
  shortlist: Array<{ pairId: string }>,
  ctx: JobContext,
): Promise<Array<{ pairId: string; entityId: number }>> {
  const unresolved = shortlist.filter((c) => !entityIdCache.has(c.pairId));

  if (unresolved.length > 0) {
    const { rows } = await pool.query<{ pair_id: string; name: string }>(
      `SELECT p.id AS pair_id, a.name
       FROM trading_pairs p
       JOIN assets a ON a.id = p.base_asset_id
       WHERE p.id = ANY($1::uuid[])`,
      [unresolved.map((c) => c.pairId)],
    );
    const nameByPairId = new Map(rows.map((r) => [r.pair_id, r.name]));

    for (const candidate of unresolved) {
      const assetName = nameByPairId.get(candidate.pairId);
      if (!assetName) continue; // shouldn't happen -- shortlist pairs come straight from trading_pairs
      const entityId = await resolveEntityId(assetName, ctx);
      if (entityId !== null) entityIdCache.set(candidate.pairId, entityId);
    }
  }

  const resolved: Array<{ pairId: string; entityId: number }> = [];
  for (const candidate of shortlist) {
    const entityId = entityIdCache.get(candidate.pairId);
    if (entityId !== undefined) resolved.push({ pairId: candidate.pairId, entityId });
  }
  return resolved;
}

/**
 * Fetches one batch's news (up to ENTITY_BATCH_SIZE entity IDs, OR
 * logic) and decides flagged_negative per pair from the most recent
 * article whose entities[] includes that pair's resolved entity.id
 * (results are requested sorted published_at desc, so the first match
 * per pair is the most recent by construction).
 *
 * Returns null on a total fetch failure -- the caller must skip the
 * upsert for this batch's pairs entirely rather than treat a failure as
 * "checked, found nothing negative" (see file header).
 */
async function fetchBatchFlags(
  batch: Array<{ pairId: string; entityId: number }>,
  ctx: JobContext,
): Promise<Map<string, PairFlag> | null> {
  const entityIdParam = batch.map((b) => b.entityId).join(",");
  const url = `${APITUBE_BASE_URL}/news/everything?entity.id=${entityIdParam}&per_page=25&sort.by=published_at&sort.order=desc`;

  let articles: ApiTubeArticle[];
  try {
    const json = await fetchJson(url);
    articles = (json as { results?: ApiTubeArticle[] } | null)?.results ?? [];
  } catch (err) {
    ctx.logger.warn({ pairIds: batch.map((b) => b.pairId), err }, "news_agent_batch_fetch_failed");
    return null;
  }

  const result = new Map<string, PairFlag>();
  for (const { pairId, entityId } of batch) {
    const match = articles.find((a) => a.entities?.some((e) => e.id === entityId));
    if (!match) {
      result.set(pairId, { flagged: false, reason: null, headline: null });
      continue;
    }

    const score = match.sentiment?.overall?.score;
    const polarity = match.sentiment?.overall?.polarity;
    const isNegative = polarity === "negative" && typeof score === "number" && score <= NEGATIVE_SCORE_THRESHOLD;

    result.set(
      pairId,
      isNegative
        ? {
            flagged: true,
            reason: `APITube sentiment.overall: polarity=${polarity}, score=${(score as number).toFixed(2)}`,
            headline: match.title ?? null,
          }
        : { flagged: false, reason: null, headline: null },
    );
  }
  return result;
}

async function upsertFlag(pairId: string, flag: PairFlag, expiresAt: Date, ctx: JobContext): Promise<void> {
  await pool.query(
    `INSERT INTO pair_news_flags (pair_id, flagged_negative, reason, source_headline, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (pair_id) DO UPDATE SET
       flagged_negative = EXCLUDED.flagged_negative,
       reason = EXCLUDED.reason,
       source_headline = EXCLUDED.source_headline,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    [pairId, flag.flagged, flag.reason, flag.headline, expiresAt],
  );
  if (flag.flagged) {
    ctx.logger.warn({ pairId, reason: flag.reason }, "news_agent_pair_flagged_negative");
  }
}

export const newsAgentJob: JobDefinition = {
  name: "news-agent",
  // 10 min -- see file header for the quota reasoning (3 req/cycle,
  // 432/day, within the account's confirmed 1,000/day plan).
  intervalSeconds: 600,
  timeoutMs: 30_000,
  maxRunSeconds: 45,
  async run(ctx) {
    if (!config.newsAgentEnabled) return;

    // Loud, not silent -- every cycle the key is missing, not just once.
    // A one-time warning would fade out of recent logs while the gate
    // silently ran on data that stopped refreshing.
    if (!config.newsApiKey) {
      ctx.logger.warn("news_agent_no_api_key");
      return;
    }

    const shortlist = await getShortlist();
    if (shortlist.length === 0) return;

    const resolved = await resolveShortlistEntities(shortlist, ctx);
    if (resolved.length === 0) return;

    const expiresAt = new Date(Date.now() + FLAG_EXPIRES_MINUTES * 60_000);

    for (const batch of chunk(resolved, ENTITY_BATCH_SIZE)) {
      const flags = await fetchBatchFlags(batch, ctx);
      if (!flags) continue; // batch fetch failed -- leave these pairs' existing rows untouched

      for (const { pairId } of batch) {
        const flag = flags.get(pairId);
        if (!flag) continue;
        await upsertFlag(pairId, flag, expiresAt, ctx);
      }
    }
  },
};
