import "dotenv/config";

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

export const config = {
  port: numberEnv("PORT", 3001),
  host: process.env.HOST ?? "0.0.0.0",

  nodeEnv,
  isProd,

  jwtAccessSecret: requireEnv("JWT_ACCESS_SECRET"),
  jwtRefreshSecret: requireEnv("JWT_REFRESH_SECRET"),

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

  // ── Phase 10 PR2: Observability ──
  dbSlowQueryMs: numberEnv("DB_SLOW_QUERY_MS", 200),
  dbLogSqlOnSlow: booleanEnv("DB_LOG_SQL_ON_SLOW", false),
  lockSamplerEnabled: booleanEnv("LOCK_SAMPLER_ENABLED", !isProd),
  lockSamplerIntervalMs: numberEnv("LOCK_SAMPLER_INTERVAL_MS", 5000),
  lockSamplerTopN: numberEnv("LOCK_SAMPLER_TOPN", 10),
};
