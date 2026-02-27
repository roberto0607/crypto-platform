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
