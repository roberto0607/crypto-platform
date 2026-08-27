-- ============================================================
-- 091_pair_news_flags.sql
-- Cache table for the News Agent safety gate (Gate 1f).
-- ============================================================
--
-- Context:
--   News Agent is a deterministic (no LLM) safety gate parallel to Risk
--   Agent -- it can only ever block/delay an already-approved trade,
--   never cause one. Same shape as Execution Agent's existing
--   stale-price guard in executor.ts (source: "fallback" check before
--   order placement).
--
--   A periodic job (newsAgentJob.ts, Gate 1f) polls a news API for
--   recent headlines per tracked pair and upserts the API's own
--   pre-scored sentiment here. Execution Agent's runPhase1 does a fast
--   local SELECT against this table (same slot as the stale-price
--   check, before placeOrderWithSnapshot) instead of calling the news
--   API synchronously inside its held row lock -- mirrors why
--   resolveSnapshot reads a snapshot store instead of hitting an
--   exchange API live.
--
--   One row per pair_id (upserted in place, not appended) -- the gate
--   only ever needs the CURRENT flag for a pair, not a history of past
--   flags. expires_at bounds how long a flag is trusted stale-safe: a
--   flag older than its expiry is treated as no-signal (not
--   negative), same "don't trust a stale value" philosophy as
--   resolveSnapshot's own 10s staleness TTL, just on a much longer
--   (30-60min) horizon appropriate to how often real news actually
--   changes.
--
--   Nullable/additive only, same convention as 089/090.
-- ============================================================

CREATE TABLE pair_news_flags (
    pair_id UUID PRIMARY KEY REFERENCES trading_pairs(id),
    flagged_negative BOOLEAN NOT NULL DEFAULT false,
    reason TEXT,
    source_headline TEXT,
    expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot path for the gate: "is this pair currently flagged and not yet
-- expired". Partial index -- most pairs most of the time will be
-- flagged_negative = false, so only indexing the true rows keeps this
-- small and keeps the executor.ts check cheap regardless of how many
-- pairs the job tracks.
CREATE INDEX idx_pair_news_flags_flagged
    ON pair_news_flags (pair_id, expires_at)
    WHERE flagged_negative = true;
