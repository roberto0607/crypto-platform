/**
 * metrics.ts — Prometheus metrics collection and /metrics endpoint.
 *
 * Registers a Fastify plugin that:
 *  1. Collects request_count and request_duration_seconds via onResponse hook.
 *  2. Exposes pg_pool gauges (total, idle, waiting).
 *  3. Serves GET /metrics in Prometheus text format.
 *
 * The hook stamps req.startTime in onRequest so duration is accurate.
 */

import type { FastifyPluginAsync } from "fastify";
import client from "prom-client";
import { pool } from "./db/pool";

// ── Metrics definitions ──

const httpRequestCount = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"] as const,
});

const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

new client.Gauge({
  name: "pg_pool_total_count",
  help: "Total number of clients in the PG pool",
  collect() { this.set(pool.totalCount); },
});

new client.Gauge({
  name: "pg_pool_idle_count",
  help: "Number of idle clients in the PG pool",
  collect() { this.set(pool.idleCount); },
});

new client.Gauge({
  name: "pg_pool_waiting_count",
  help: "Number of clients waiting for a PG connection",
  collect() { this.set(pool.waitingCount); },
});

// ── Reconciliation counters ──

export const reconciliationRunsTotal = new client.Counter({
  name: "reconciliation_runs_total",
  help: "Total number of reconciliation runs",
});

export const reconciliationFailuresTotal = new client.Counter({
  name: "reconciliation_failures_total",
  help: "Total number of reconciliation runs that encountered errors",
});

export const reconciliationWalletMismatches = new client.Counter({
  name: "reconciliation_wallet_mismatches",
  help: "Total number of wallet balance mismatches detected",
});

export const reconciliationPositionMismatches = new client.Counter({
  name: "reconciliation_position_mismatches",
  help: "Total number of position mismatches detected",
});

// ── Risk control counters ──

export const riskChecksTotal = new client.Counter({
  name: "risk_checks_total",
  help: "Total pre-trade risk evaluations",
});

export const riskRejectionsTotal = new client.Counter({
  name: "risk_rejections_total",
  help: "Risk-rejected orders",
  labelNames: ["code"] as const,
});

export const breakerTripsTotal = new client.Counter({
  name: "breaker_trips_total",
  help: "Circuit breaker trip events",
  labelNames: ["breaker"] as const,
});

export const breakerBlocksTotal = new client.Counter({
  name: "breaker_blocks_total",
  help: "Orders blocked by circuit breakers",
  labelNames: ["breaker"] as const,
});

// ── Event backbone metrics ──

export const eventConnectionsActive = new client.Gauge({
  name: "event_connections_active",
  help: "Number of active SSE connections",
});

export const eventsPublishedTotal = new client.Counter({
  name: "events_published_total",
  help: "Total events published",
  labelNames: ["type"] as const,
});

export const eventsDeliveryFailuresTotal = new client.Counter({
  name: "event_delivery_failures_total",
  help: "Total event delivery failures",
});

// ── Phase 7 PR3: Latency histograms ──

export const orderPlacementLatency = new client.Histogram({
  name: "order_placement_latency_ms",
  help: "Order placement end-to-end latency in milliseconds",
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
});

export const riskEvaluationLatency = new client.Histogram({
  name: "risk_evaluation_latency_ms",
  help: "Risk evaluation latency in milliseconds",
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
});

export const reconciliationRunLatency = new client.Histogram({
  name: "reconciliation_run_latency_ms",
  help: "Reconciliation run latency in milliseconds",
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

export const eventDeliveryLatency = new client.Histogram({
  name: "event_delivery_latency_ms",
  help: "Event delivery latency in milliseconds",
  buckets: [0.1, 0.5, 1, 5, 10, 25, 50],
});

// ── Phase 7 PR3: Domain counters/gauges ──

export const ordersCreatedTotal = new client.Counter({
  name: "orders_created_total",
  help: "Total orders successfully created",
});

export const ordersRejectedTotal = new client.Counter({
  name: "orders_rejected_total",
  help: "Total orders rejected",
  labelNames: ["reason"] as const,
});

// ── Phase 9 PR1: Governance counters ──

export const governanceRejectionsTotal = new client.Counter({
  name: "governance_rejections_total",
  help: "Orders rejected by account governance",
  labelNames: ["code"] as const,
});

export const accountLocksTotal = new client.Counter({
  name: "account_locks_total",
  help: "Total account lock/suspend events",
});

export const dailyLimitHitsTotal = new client.Counter({
  name: "daily_limit_hits_total",
  help: "Total daily limit hits (notional or loss)",
});

export const reconciliationStatusGauge = new client.Gauge({
  name: "reconciliation_status",
  help: "Last reconciliation status (1 = current)",
  labelNames: ["status"] as const,
});

new client.Gauge({
  name: "db_pool_in_use",
  help: "Number of PG pool clients currently in use",
  collect() { this.set(pool.totalCount - pool.idleCount); },
});

// ── Phase 9 PR2: Job runner metrics ──

export const jobRunsTotal = new client.Counter({
  name: "job_runs_total",
  help: "Total job executions",
  labelNames: ["job", "status"] as const,
});

export const jobDurationMs = new client.Histogram({
  name: "job_duration_ms",
  help: "Job execution duration in milliseconds",
  labelNames: ["job"] as const,
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
});

export const jobLockContentionTotal = new client.Counter({
  name: "job_lock_contention_total",
  help: "Number of times a job was skipped due to lock contention",
  labelNames: ["job"] as const,
});

export const cleanupTokensDeletedTotal = new client.Counter({
  name: "cleanup_tokens_deleted_total",
  help: "Total stale refresh tokens deleted by cleanup job",
});

export const replaySessionsCleanedTotal = new client.Counter({
  name: "replay_sessions_cleaned_total",
  help: "Total stale replay sessions cleaned",
});

export const idempotencyKeysDeletedTotal = new client.Counter({
  name: "idempotency_keys_deleted_total",
  help: "Total expired idempotency keys deleted",
});

// ── Phase 9 PR3: Retention metrics ──

export const retentionRowsDeletedTotal = new client.Counter({
    name: "retention_rows_deleted_total",
    help: "Total rows deleted by retention job",
    labelNames: ["table"] as const,
});

export const retentionRollupsTotal = new client.Counter({
    name: "retention_rollups_total",
    help: "Total rows rolled up by retention job",
    labelNames: ["type"] as const,
});

export const retentionDurationMs = new client.Histogram({
    name: "retention_duration_ms",
    help: "Retention job total duration in milliseconds",
    buckets: [100, 500, 1000, 2500, 5000, 10000, 30000, 60000],
});

export const retentionFailuresTotal = new client.Counter({
    name: "retention_failures_total",
    help: "Total retention job failures",
});

// ── Phase 9 PR4: Queue metrics ──

export const pairQueueDepth = new client.Gauge({
  name: "pair_queue_depth",
  help: "Current queue depth per trading pair",
  labelNames: ["pairId"] as const,
});

export const pairQueueRejectionsTotal = new client.Counter({
  name: "pair_queue_rejections_total",
  help: "Orders rejected due to queue backpressure",
  labelNames: ["pairId"] as const,
});

export const pairQueueExecMs = new client.Histogram({
  name: "pair_queue_exec_ms",
  help: "Order execution time within queue worker (ms)",
  labelNames: ["pairId"] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

export const pairQueueWaitMs = new client.Histogram({
  name: "pair_queue_wait_ms",
  help: "Time spent waiting in queue before execution (ms)",
  labelNames: ["pairId"] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

// ── Phase 9 PR5: Reconciliation findings metrics ──

export const reconFindingsTotal = new client.Counter({
  name: "reconciliation_findings_total",
  help: "Total reconciliation findings by check and severity",
  labelNames: ["check", "severity"] as const,
});

export const reconQuarantinesTotal = new client.Counter({
  name: "reconciliation_quarantines_total",
  help: "Total users quarantined by reconciliation",
});

// ── Phase 9 PR6: Repair metrics ──

export const repairsTotal = new client.Counter({
  name: "repairs_total",
  help: "Total repair runs by mode and status",
  labelNames: ["mode", "status"] as const,
});

export const repairsPositionsUpdatedTotal = new client.Counter({
  name: "repairs_positions_updated_total",
  help: "Total positions updated by repair",
});

export const repairsDurationMs = new client.Histogram({
  name: "repairs_duration_ms",
  help: "Repair run duration in milliseconds",
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
});

// ── Phase 9 PR7: Incident metrics ──

export const incidentsOpenTotal = new client.Counter({
  name: "incidents_open_total",
  help: "Total incidents opened",
});

export const incidentsResolvedTotal = new client.Counter({
  name: "incidents_resolved_total",
  help: "Total incidents resolved",
});

export const incidentsAckTotal = new client.Counter({
  name: "incidents_ack_total",
  help: "Total incidents acknowledged",
});

export const proofPacksGeneratedTotal = new client.Counter({
  name: "proof_packs_generated_total",
  help: "Total proof packs generated",
});

export const proofPackBuildMs = new client.Histogram({
  name: "proof_pack_build_ms",
  help: "Proof pack build duration in milliseconds",
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
});

// ── Phase 9 PR8: Event stream metrics ──

export const eventStreamTotal = new client.Counter({
  name: "event_stream_total",
  help: "Total events appended to the hash-linked event stream",
  labelNames: ["event_type"] as const,
});

export const eventStreamVerifyRunsTotal = new client.Counter({
  name: "event_stream_verify_runs_total",
  help: "Total chain verification runs",
});

export const eventStreamVerifyFailuresTotal = new client.Counter({
  name: "event_stream_verify_failures_total",
  help: "Total chain verification failures (tamper detected)",
});

export const eventStreamVerifyDurationMs = new client.Histogram({
  name: "event_stream_verify_duration_ms",
  help: "Chain verification duration in milliseconds",
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
});

// ── Phase 9 PR9: Outbox metrics ──

export const outboxEventsTotal = new client.Counter({
  name: "outbox_events_total",
  help: "Total outbox events enqueued",
  labelNames: ["event_type"] as const,
});

export const outboxProcessedTotal = new client.Counter({
  name: "outbox_processed_total",
  help: "Total outbox events successfully processed",
  labelNames: ["event_type"] as const,
});

export const outboxFailuresTotal = new client.Counter({
  name: "outbox_failures_total",
  help: "Total outbox event processing failures",
  labelNames: ["event_type"] as const,
});

export const outboxRetriesTotal = new client.Counter({
  name: "outbox_retries_total",
  help: "Total outbox event retries",
  labelNames: ["event_type"] as const,
});

export const outboxProcessingDurationMs = new client.Histogram({
  name: "outbox_processing_duration_ms",
  help: "Outbox event processing duration in milliseconds",
  labelNames: ["event_type"] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

export const outboxQueueDepth = new client.Gauge({
  name: "outbox_queue_depth",
  help: "Current number of pending outbox events",
});

// ── Phase 9 PR10: Backup + disaster recovery metrics ──

export const backupsCreatedTotal = new client.Counter({
  name: "backups_created_total",
  help: "Total backup files created by backup.sh",
});

export const backupRestoreDrillsTotal = new client.Counter({
  name: "backup_restore_drills_total",
  help: "Total restore drills executed",
});

export const backupRestoreFailuresTotal = new client.Counter({
  name: "backup_restore_failures_total",
  help: "Total restore drill failures",
});

export const migrationGuardFailuresTotal = new client.Counter({
  name: "migration_guard_failures_total",
  help: "Total migration guard failures at startup (DB/code version mismatch)",
});

export const restoreDurationMs = new client.Histogram({
  name: "restore_duration_ms",
  help: "Restore drill duration in milliseconds",
  buckets: [1000, 5000, 10000, 30000, 60000, 120000, 300000],
});

// ── Phase 10 PR2: DB query timing metrics ──

export const dbQueryTotal = new client.Counter({
  name: "db_query_total",
  help: "Total DB queries by operation name",
  labelNames: ["name"] as const,
});

export const dbQueryDurationMs = new client.Histogram({
  name: "db_query_duration_ms",
  help: "DB query latency in milliseconds",
  labelNames: ["name"] as const,
  buckets: [1, 5, 10, 25, 50, 100, 200, 500, 1000, 2500, 5000],
});

export const dbPoolAcquireDurationMs = new client.Histogram({
  name: "db_pool_acquire_duration_ms",
  help: "Time to acquire a client from the PG pool in milliseconds",
  buckets: [0.1, 0.5, 1, 5, 10, 25, 50, 100, 250, 500],
});

// ── Phase 10 PR2: Lock sampler metrics ──

export const pgLockWaitingTotal = new client.Gauge({
  name: "pg_lock_waiting_total",
  help: "Number of queries currently waiting on locks",
});

export const pgLockWaitDurationMaxSeconds = new client.Gauge({
  name: "pg_lock_wait_duration_max_seconds",
  help: "Longest current lock wait in seconds",
});

export const pgLockedRelationWaits = new client.Gauge({
  name: "pg_locked_relation_waits",
  help: "Per-relation lock wait count (top-N)",
  labelNames: ["relname"] as const,
});

// ── Phase 10 PR2: HTTP inflight gauge ──

export const httpInflightRequests = new client.Gauge({
  name: "http_inflight_requests",
  help: "Currently in-flight HTTP requests",
});

// ── Phase 10 PR4: Load shedding metrics ──

export const loadSheddingRejectionsTotal = new client.Counter({
  name: "load_shedding_rejections_total",
  help: "Requests rejected by load shedding",
  labelNames: ["reason"] as const,
});

export const loadStateOverloadedGauge = new client.Gauge({
  name: "load_state_overloaded",
  help: "Whether the system is currently in overloaded state (1 = yes)",
});

export const dbPoolWaitingGauge = new client.Gauge({
  name: "db_pool_waiting_gauge",
  help: "Current number of clients waiting for a PG connection (load shedding view)",
});

export const priorityRejectionTotal = new client.Counter({
  name: "priority_rejection_total",
  help: "Requests rejected by priority class",
  labelNames: ["priority"] as const,
});

// ── Phase 10 PR6: Beta access layer metrics ──

export const quotaExceededTotal = new client.Counter({
  name: "quota_exceeded_total",
  help: "Orders rejected by per-user quota checks",
  labelNames: ["type"] as const,
});

export const tradingPausedTotal = new client.Counter({
  name: "trading_paused_total",
  help: "Orders rejected by kill switches",
  labelNames: ["scope"] as const,
});

export const inviteConsumedTotal = new client.Counter({
  name: "invite_consumed_total",
  help: "Total beta invites consumed during registration",
});

export const suspiciousActivityTotal = new client.Counter({
  name: "suspicious_activity_total",
  help: "Users flagged for suspicious order burst activity",
});

export const readOnlyRejectionsTotal = new client.Counter({
  name: "read_only_rejections_total",
  help: "Requests rejected due to read-only mode",
});

export const userTradingDisabledTotal = new client.Counter({
  name: "user_trading_disabled_total",
  help: "Orders rejected because user trading is disabled",
});

// ── Phase 10 PR7: Security hardening metrics ──

export const apiKeyCreatedTotal = new client.Counter({
  name: "api_key_created_total",
  help: "Total API keys created",
});

export const apiKeyRevokedTotal = new client.Counter({
  name: "api_key_revoked_total",
  help: "Total API keys revoked",
});

export const apiKeyAuthTotal = new client.Counter({
  name: "api_key_auth_total",
  help: "Total successful API key authentications",
});

export const loginBlockedTotal = new client.Counter({
  name: "login_blocked_total",
  help: "Total login attempts blocked by abuse protection",
});

export const apiKeyRateLimitedTotal = new client.Counter({
  name: "api_key_rate_limited_total",
  help: "Total requests rejected by API key rate limiter",
});

// ── Phase 12 PR1: Invariant enforcement metrics ──

export const invariantViolationsTotal = new client.Counter({
  name: "invariant_violations_total",
  help: "Total post-trade invariant violations detected",
  labelNames: ["type"] as const,
});

// ── Phase 12 PR2: Auth hardening metrics ──

export const refreshTokenReuseDetectedTotal = new client.Counter({
  name: "refresh_token_reuse_detected_total",
  help: "Refresh token reuse detection events (potential theft)",
});

export const refreshTokenFamilyRevokedTotal = new client.Counter({
  name: "refresh_token_family_revoked_total",
  help: "Full token family revocations triggered by reuse detection",
});

export const loginAttemptsDeletedTotal = new client.Counter({
  name: "login_attempts_deleted_total",
  help: "Login attempt records cleaned up",
});

// ── Phase 12 PR3: Redis metrics ──

export const redisCommandDuration = new client.Histogram({
  name: "redis_command_duration_seconds",
  help: "Redis command latency",
  labelNames: ["command"] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1],
});

export const redisPublishTotal = new client.Counter({
  name: "redis_publish_total",
  help: "Redis pub/sub messages published",
  labelNames: ["channel"] as const,
});

export const redisSubscribeDeliveryTotal = new client.Counter({
  name: "redis_subscribe_delivery_total",
  help: "Redis pub/sub messages received and delivered locally",
  labelNames: ["channel"] as const,
});

// ── Phase 13 PR3: Email metrics ──

export const emailsSentTotal = new client.Counter({
  name: "emails_sent_total",
  help: "Emails sent",
  labelNames: ["kind"] as const,
});

export const emailVerificationsTotal = new client.Counter({
  name: "email_verifications_total",
  help: "Successful email verifications",
});

export const passwordResetsTotal = new client.Counter({
  name: "password_resets_total",
  help: "Successful password resets",
});

// ── Plugin ──

declare module "fastify" {
  interface FastifyRequest {
    startTime?: [number, number];
  }
}

const metricsPlugin: FastifyPluginAsync = async (app) => {
  // Stamp start time on every request + track inflight
  app.addHook("onRequest", async (req) => {
    req.startTime = process.hrtime();
    httpInflightRequests.inc();
  });

  // Record metrics after every response
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? req.url;
    const labels = {
      method: req.method,
      route,
      status: String(reply.statusCode),
    };

    httpInflightRequests.dec();
    httpRequestCount.inc(labels);

    if (req.startTime) {
      const diff = process.hrtime(req.startTime);
      const durationSec = diff[0] + diff[1] / 1e9;
      httpRequestDuration.observe(labels, durationSec);
    }
  });

  // Serve metrics
  app.get("/metrics", async (_req, reply) => {
    const metrics = await client.register.metrics();
    reply.header("Content-Type", client.register.contentType).send(metrics);
  });
};

export default metricsPlugin;
