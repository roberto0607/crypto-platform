import "dotenv/config";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function numberEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number`);
  return n;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (!v) return fallback;
  return v === "true" || v === "1";
}

/** Default market-data storage allowlist (MARKET_SYMBOLS). */
export const DEFAULT_MARKET_SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD"] as const;

/**
 * Normalize an exchange-style pair symbol to our trading_pairs.symbol form:
 * "btc-usd" / "BTC/USD" / " BTC-USD " → "BTC/USD". Throws on anything that
 * isn't BASE<sep>QUOTE so a typo in MARKET_SYMBOLS fails at boot instead of
 * silently storing nothing for that pair.
 */
export function normalizeMarketSymbol(raw: string): string {
  const parts = raw.trim().toUpperCase().split(/[-/]/);
  if (parts.length !== 2 || !/^[A-Z0-9]+$/.test(parts[0]!) || !/^[A-Z0-9]+$/.test(parts[1]!)) {
    throw new Error(`Invalid market symbol "${raw}" — expected BASE-QUOTE, e.g. BTC-USD`);
  }
  return `${parts[0]}/${parts[1]}`;
}

/** Parse MARKET_SYMBOLS (comma-separated); unset/blank → the default three. */
export function parseMarketSymbols(raw: string | undefined): ReadonlySet<string> {
  const tokens = (raw ?? "").split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  const list = tokens.length > 0 ? tokens : [...DEFAULT_MARKET_SYMBOLS];
  return new Set(list.map(normalizeMarketSymbol));
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const isProd = nodeEnv === "production";

// Master switch for every agent (Scanner, Chart Analysis, Risk, Execution,
// News). Off by default in production; each per-agent flag below is ANDed
// with it, so AGENTS_ENABLED=false wins no matter what the individual flags
// say. Outside prod it defaults on so the per-agent flags alone decide.
const agentsEnabled = booleanEnv("AGENTS_ENABLED", !isProd);

// Boot-time safety guard: rate limiting must remain enabled in production.
if (isProd && (process.env.DISABLE_RATE_LIMIT === "true" || process.env.DISABLE_RATE_LIMIT === "1")) {
  throw new Error("DISABLE_RATE_LIMIT cannot be true in production");
}

const jwtAccessTtlSeconds = numberEnv("JWT_ACCESS_TTL_SECONDS", 900);

// Prefer seconds if provided; otherwise fall back to days.
const jwtRefreshTtlSeconds =
  process.env.JWT_REFRESH_TTL_SECONDS
    ? numberEnv("JWT_REFRESH_TTL_SECONDS", 60 * 60 * 24 * 30)
    : numberEnv("JWT_REFRESH_TTL_DAYS", 30) * 24 * 60 * 60;

// ── Instance identity (Phase 10 PR5) ──
type InstanceRole = "API" | "WORKER" | "ALL";

function instanceRoleEnv(): InstanceRole {
  const v = (process.env.INSTANCE_ROLE ?? "ALL").toUpperCase();
  if (v === "API" || v === "WORKER" || v === "ALL") return v;
  throw new Error(`Invalid INSTANCE_ROLE: ${v}. Must be API | WORKER | ALL`);
}

export const config = {
  port: numberEnv("PORT", 3001),
  host: process.env.HOST ?? "0.0.0.0",

  nodeEnv,
  isProd,

  jwtAccessSecret: requireEnv("JWT_ACCESS_SECRET"),

  jwtAccessTtlSeconds,
  jwtRefreshTtlSeconds,

  maxQueueDepth: numberEnv("MAX_QUEUE_DEPTH", 100),
  queueTimeoutMs: numberEnv("QUEUE_TIMEOUT_MS", 5000),

  outboxWorkerEnabled: booleanEnv("OUTBOX_WORKER_ENABLED", true),
  outboxBatchSize: numberEnv("OUTBOX_BATCH_SIZE", 50),
  outboxPollIntervalMs: numberEnv("OUTBOX_POLL_INTERVAL_MS", 1000),
  outboxProcessingTimeoutMs: numberEnv("OUTBOX_PROCESSING_TIMEOUT_MS", 60000),

  // ── Phase 9 PR10: Disaster Recovery ──
  backupDir: process.env.BACKUP_DIR ?? "./backups",
  backupRetentionDays: numberEnv("BACKUP_RETENTION_DAYS", 14),
  restoreDbName: process.env.RESTORE_DB_NAME ?? "cp_restore_test",
  disableRateLimit: booleanEnv("DISABLE_RATE_LIMIT", false),
  // Number of reverse-proxy hops in front of the API whose X-Forwarded-For
  // entries Fastify should trust when computing req.ip. 0 (default) keeps
  // req.ip = the TCP peer, which behind Railway's edge is the proxy itself —
  // so any per-IP limit buckets every visitor together until this is set.
  trustProxyHops: numberEnv("TRUST_PROXY_HOPS", 0),
  disableJobRunner: booleanEnv("DISABLE_JOB_RUNNER", false),

  // ── Phase 10 PR3: Pool tuning ──
  dbPoolMax: numberEnv("DB_POOL_MAX", 20),
  // Max wait for a free pool client before pg errors (pool.connect/pool.query).
  dbPoolAcquireTimeoutMs: numberEnv("DB_POOL_ACQUIRE_TIMEOUT_MS", 10_000),
  // Job runner pool safety (see jobs/jobRunner.ts). Concurrency is further
  // clamped at start() so in-flight jobs can never exhaust the pool.
  jobMaxConcurrency: numberEnv("JOB_MAX_CONCURRENCY", 4),

  // ── Phase 10 PR2: Observability ──
  dbSlowQueryMs: numberEnv("DB_SLOW_QUERY_MS", 200),
  dbLogSqlOnSlow: booleanEnv("DB_LOG_SQL_ON_SLOW", false),
  lockSamplerEnabled: booleanEnv("LOCK_SAMPLER_ENABLED", !isProd),
  lockSamplerIntervalMs: numberEnv("LOCK_SAMPLER_INTERVAL_MS", 5000),
  lockSamplerTopN: numberEnv("LOCK_SAMPLER_TOPN", 10),

  // ── Phase 10 PR4: Capacity guardrails ──
  maxDbPoolWaiting: numberEnv("MAX_DB_POOL_WAITING", 20),
  maxOutboxQueueDepth: numberEnv("MAX_OUTBOX_QUEUE_DEPTH", 1000),
  maxLockWaiting: numberEnv("MAX_LOCK_WAITING", 10),
  maxInflightRequests: numberEnv("MAX_INFLIGHT_REQUESTS", 500),
  loadSheddingEnabled: booleanEnv("LOAD_SHEDDING_ENABLED", true),

  // ── Phase 10 PR5: Instance identity ──
  instanceId: process.env.INSTANCE_ID || `${hostname()}-${randomUUID().slice(0, 8)}`,
  instanceRole: instanceRoleEnv(),
  runMigrationsOnBoot: booleanEnv("RUN_MIGRATIONS_ON_BOOT", false),

  // ── Phase 12 PR3: Redis for distributed state ──
  redisUrl: process.env.REDIS_URL || "",

  // ── Phase 10 PR6: Beta access layer ──
  betaMode: booleanEnv("BETA_MODE", false),
  maxOrderBurst: numberEnv("MAX_ORDER_BURST", 20),
  orderBurstWindowMs: numberEnv("ORDER_BURST_WINDOW_MS", 5000),

  // ── Phase 10 PR7: Security hardening ──
  maxLoginAttemptsPerEmail: numberEnv("MAX_LOGIN_ATTEMPTS_PER_EMAIL", 5),
  maxLoginAttemptsPerIp: numberEnv("MAX_LOGIN_ATTEMPTS_PER_IP", 20),
  loginBlockWindowMinutes: numberEnv("LOGIN_BLOCK_WINDOW_MINUTES", 15),
  maxApiKeyReqPerMin: numberEnv("MAX_API_KEY_REQ_PER_MIN", 120),
  suspiciousCancelBurstThreshold: numberEnv("SUSPICIOUS_CANCEL_BURST_THRESHOLD", 15),
  suspiciousOrderWindowMs: numberEnv("SUSPICIOUS_ORDER_WINDOW_MS", 10000),

  // ── Phase 13 PR3: Email ──
  sendgridApiKey: process.env.SENDGRID_API_KEY || "",
  emailFrom: process.env.EMAIL_FROM || "noreply@crypto-platform.local",
  appUrl: process.env.APP_URL || "http://localhost:5173",
  requireEmailVerification: booleanEnv("REQUIRE_EMAIL_VERIFICATION", false),

  // ── Phase 13 PR4: Swagger UI ──
  enableSwaggerUi: booleanEnv("ENABLE_SWAGGER_UI", !isProd),

  // ── Phase 15: Live market data ──
  krakenWsEnabled: booleanEnv("KRAKEN_WS_ENABLED", true),
  lastPriceSyncIntervalMs: numberEnv("LAST_PRICE_SYNC_INTERVAL_MS", 1000),

  // ── Market maker bot ──
  disableMarketMaker: booleanEnv("DISABLE_MARKET_MAKER", false),
  // Set this to a random UUID in production via Railway env vars.
  botUserId: process.env.BOT_USER_ID ?? "00000000-0000-0000-0000-000000000001",

  // ── DB recovery: market-data storage allowlist ──
  // Only these pairs ever get candle / footprint rows written. Every other
  // active pair still streams live (price.tick / candle.closed events,
  // trading_pairs.last_price) but nothing is persisted as history for it.
  // Normalized to trading_pairs.symbol form ("BTC/USD").
  marketSymbols: parseMarketSymbols(process.env.MARKET_SYMBOLS),

  // ── DB recovery: storage-budget retention (storage-retention job) ──
  // Fine-grained candles age out; 1h/4h/1d/1w are kept indefinitely (a few
  // MB per pair per year). Set a window to 0 to keep that series forever.
  retentionCandle1mDays: numberEnv("RETENTION_CANDLE_1M_DAYS", 30),
  retentionCandle5mDays: numberEnv("RETENTION_CANDLE_5M_DAYS", 365),
  retentionCandle15mDays: numberEnv("RETENTION_CANDLE_15M_DAYS", 365),
  retentionAgentRunLogDays: numberEnv("RETENTION_AGENT_RUN_LOG_DAYS", 14),
  retentionOutboxDoneDays: numberEnv("RETENTION_OUTBOX_DONE_DAYS", 7),

  // ── DB recovery: disk-pressure guardrail (observability/dbSizeGuard.ts) ──
  // Set DB_SIZE_LIMIT_MB to the Postgres volume size (MB). 0/unset = size is
  // still logged hourly but the warn/pause thresholds are inactive.
  dbSizeLimitMb: numberEnv("DB_SIZE_LIMIT_MB", 0),
  dbSizeWarnPct: numberEnv("DB_SIZE_WARN_PCT", 70),
  dbSizeCriticalPct: numberEnv("DB_SIZE_CRITICAL_PCT", 85),
  dbSizeCheckIntervalMs: numberEnv("DB_SIZE_CHECK_INTERVAL_MS", 3_600_000),
  dbSizeElevatedIntervalMs: numberEnv("DB_SIZE_ELEVATED_INTERVAL_MS", 300_000),

  // ── Phase 19: Candle backfill on boot ──
  candleBackfillOnBoot: booleanEnv("CANDLE_BACKFILL_ON_BOOT", true),

  // ── Phase 20: ML signals ──
  mlServiceUrl: process.env.ML_SERVICE_URL || "http://localhost:8000",
  mlPredictionEnabled: booleanEnv("ML_PREDICTION_ENABLED", true),
  mlMinConfidence: numberEnv("ML_MIN_CONFIDENCE", 70),
  mlSignalCooldownMs: numberEnv("ML_SIGNAL_COOLDOWN_MS", 300_000), // 5 min between signals per pair
  mlSignalExpiryHours: numberEnv("ML_SIGNAL_EXPIRY_HOURS", 24),

  // ── Phase 22: Derivatives data ──
  derivativesPollerEnabled: booleanEnv("DERIVATIVES_POLLER_ENABLED", true),

  // ── Gate 1e: human-alerting escalation ──
  // Deliberately NOT requireEnv()'d -- same reasoning as anthropicApiKey
  // below: an unconfigured value degrades to a logged warning (see
  // executor.ts's alertHumanOnRecoveryFailure), it doesn't block server
  // boot.
  opsAlertEmail: process.env.OPS_ALERT_EMAIL || "",

  // ── Agents: master switch + run-log persistence policy ──
  agentsEnabled,
  // agent_run_logs persistence: errors and runs that produced an action
  // (a trade proposal) are always written. Plain successful cycles are
  // written only as a heartbeat (at most one per agent per
  // AGENT_LOG_HEARTBEAT_MINUTES -- keeps agentHealthWatchdogJob's 90-min
  // "last success" check truthful) plus a random AGENT_LOG_SAMPLE_RATE
  // fraction, instead of one row every cycle.
  agentLogSampleRate: numberEnv("AGENT_LOG_SAMPLE_RATE", 0.05),
  agentLogHeartbeatMinutes: numberEnv("AGENT_LOG_HEARTBEAT_MINUTES", 30),

  // ── Gate 1b: Scanner Agent ──
  // Deliberately NOT requireEnv()'d here — unlike jwtAccessSecret, this key
  // is only needed by the Scanner Agent, an optional, schedulable background
  // feature, not core to server boot. Making it hard-required at config
  // parse time would force every environment (local dev without a key, CI)
  // to configure it just to start the server. requireEnv() is still the
  // enforcement mechanism -- it's called lazily, at the point the agent
  // runner actually constructs the Anthropic client (see
  // agents/scanner/runner.ts), so the failure surfaces only when the
  // feature that needs it actually runs.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,

  // ── Gate 1b Task 5: Scanner Agent scheduling ──
  // Default disabled (unlike disableMarketMaker, which defaults to
  // *enabled*) -- each run costs real Anthropic API $ and needs
  // anthropicApiKey configured, so it must be opt-in per environment.
  scannerAgentEnabled: agentsEnabled && booleanEnv("SCANNER_AGENT_ENABLED", false),
  // Provisional default, not yet validated against real cost/latency data --
  // revisit after a manual observation period post-merge (see
  // agent_run_logs for actual per-run cost_usd/latency_ms once
  // SCANNER_AGENT_ENABLED=true has run for a while in some environment).
  scannerAgentIntervalSeconds: numberEnv("SCANNER_AGENT_INTERVAL_SECONDS", 1800),

  // ── Gate 1c: Chart Analysis Agent ──
  // Event-driven (reacts to scanner.result), not interval-scheduled, so
  // there's no matching *IntervalSeconds flag -- see chartAnalysisEngine.ts.
  // Default disabled for the same reason as scannerAgentEnabled: real
  // Anthropic API $ per run.
  chartAnalysisAgentEnabled: agentsEnabled && booleanEnv("CHART_ANALYSIS_AGENT_ENABLED", false),

  // ── Gate 1d: Risk Management Agent ──
  // Event-driven (reacts to chart_analysis.proposal_created), not
  // interval-scheduled -- same reasoning as chartAnalysisAgentEnabled.
  // Independent of isAgentActionsEnabled() (systemFlagService.ts), which
  // remains the gate for real order placement (Gate 1e). Default disabled
  // -- unlike Scanner/Chart Analysis this isn't an Anthropic API cost
  // concern (pure TypeScript, no LLM call, see the design doc), but it
  // still shouldn't start approving proposals and reserving risk in an
  // environment nobody has opted into yet.
  riskAgentEnabled: agentsEnabled && booleanEnv("RISK_AGENT_ENABLED", false),
  // Set this to a random UUID in production via Railway env vars, same
  // convention as botUserId above.
  riskAgentBotUserId: process.env.RISK_AGENT_BOT_USER_ID ?? "00000000-0000-0000-0000-000000000002",

  // ── Gate 1e: Execution Agent ──
  // Event-driven (reacts to risk_agent.proposal_approved), not
  // interval-scheduled -- same reasoning as riskAgentEnabled. This is the
  // only agent in the whole system permitted to call real order-placement
  // code (placeOrderWithSnapshot), so it stays gated independently of
  // isAgentActionsEnabled() (systemFlagService.ts) -- both must be true
  // for a real order to actually place: this flag gates whether the
  // engine reacts to the event at all; isAgentActionsEnabled() is
  // placeOrderWithSnapshot's own internal kill switch (phase6OrderService.ts),
  // checked automatically via the source: "agent" tag every order this
  // agent places carries -- executor.ts doesn't re-check it separately.
  // Default disabled, same as every other agent flag here.
  executionAgentEnabled: agentsEnabled && booleanEnv("EXECUTION_AGENT_ENABLED", false),

  // ── Gate 1f: News Agent ──
  // Deliberately NOT requireEnv()'d -- same reasoning as anthropicApiKey
  // above: this key is only needed by the News Agent's job (Gate 1f), an
  // optional, schedulable background feature, not core to server boot. A
  // missing key degrades to a logged warning inside the job, it doesn't
  // block server boot.
  newsApiKey: process.env.NEWS_API_KEY || "",

  // ── Pair-eligibility market-cap gate (symbol-refresh job) ──
  // CoinGecko's /coins/markets is called keyless by default -- the
  // symbol-refresh job hits it once per 6h run, well within CoinGecko's
  // 5-15 req/min public limit. Set COINGECKO_API_KEY to a free "Demo"
  // key ONLY if Railway's shared egress IP starts getting 429'd; when
  // present it's sent as x-cg-demo-api-key and raises the limit to
  // 100/min. Empty (the default) = keyless, which is expected.
  // Not requireEnv()'d -- same reasoning as newsApiKey: needed only by
  // an optional background job, never blocks server boot.
  coingeckoApiKey: process.env.COINGECKO_API_KEY || "",

  // ── Market-cap pair prune (symbol-refresh job) ──
  // When false (default) the symbol-refresh job skips the prune pass
  // entirely -- the mcap_rank_misses counter is not touched and no pair
  // is deactivated by rank. Flip to true only AFTER the one-time backlog
  // prune (scripts/prunePairs.ts) has run, so the job maintains steady
  // state (~0-2 pairs/run) instead of hitting ~180 grace-window expiries
  // in one run. Same opt-in-per-environment pattern as the agent flags.
  mcapPruneEnabled: booleanEnv("MCAP_PRUNE_ENABLED", false),

  // Event-driven at the gate (Execution Agent's runPhase1 reads
  // pair_news_flags synchronously), but the flag itself gates the
  // *populating* job (newsAgentJob.ts) -- same reasoning as
  // scannerAgentEnabled: real API cost/quota per run, so it must be
  // opt-in per environment. Default disabled, same as every other agent
  // flag here.
  newsAgentEnabled: agentsEnabled && booleanEnv("NEWS_AGENT_ENABLED", false),
};
