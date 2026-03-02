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

// ── Plugin ──

declare module "fastify" {
  interface FastifyRequest {
    startTime?: [number, number];
  }
}

const metricsPlugin: FastifyPluginAsync = async (app) => {
  // Stamp start time on every request
  app.addHook("onRequest", async (req) => {
    req.startTime = process.hrtime();
  });

  // Record metrics after every response
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? req.url;
    const labels = {
      method: req.method,
      route,
      status: String(reply.statusCode),
    };

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
