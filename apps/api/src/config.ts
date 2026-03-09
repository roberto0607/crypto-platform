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

const nodeEnv = process.env.NODE_ENV ?? "development";
const isProd = nodeEnv === "production";

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
  disableJobRunner: booleanEnv("DISABLE_JOB_RUNNER", false),

  // ── Phase 10 PR3: Pool tuning ──
  dbPoolMax: numberEnv("DB_POOL_MAX", 20),

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
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: numberEnv("SMTP_PORT", 587),
  smtpSecure: booleanEnv("SMTP_SECURE", false),
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
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
};
