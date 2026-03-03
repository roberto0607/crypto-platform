/**
 * app.ts — Fastify app factory.
 *
 * Exports buildApp() which creates and configures the Fastify instance
 * without listening. Used by server.ts (production) and tests.
 */

import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import jwt from "@fastify/jwt";

import { config } from "./config";

import metricsPlugin from "./metrics";
import healthRoutes from "./routes/healthRoutes";
import authRoutes from "./routes/authRoutes";
import adminRoutes from "./routes/adminRoutes";
import walletRoutes from "./routes/walletRoutes";
import tradingRoutes from "./routes/tradingRoutes";
import marketRoutes from "./routes/marketRoutes";
import replayRoutes from "./routes/replayRoutes";
import analyticsRoutes from "./routes/analyticsRoutes";
import riskRoutes from "./routes/riskRoutes";
import v1Routes from "./routes/v1/index";
import { startKrakenFeed } from "./market/krakenWs"
import { startTriggerEngine } from "./triggers/triggerEngine";
import { initBotRunner } from "./bot/botRunner";
import { registerJobs, start as startJobRunner } from "./jobs/jobRunner";
import { allJobs } from "./jobs/definitions/index";
import { startOutboxWorker } from "./outbox/outboxWorker";
import { startLockSampler } from "./observability/lockSampler";
import { getCurrentLoadState } from "./governance/loadState";
import { getRoutePriority } from "./governance/priorityClasses";
import { evaluateRequestPolicy, PolicyDecision } from "./governance/loadShedding";
import {
  loadSheddingRejectionsTotal,
  loadStateOverloadedGauge,
  priorityRejectionTotal,
} from "./metrics";

export interface BuildAppOptions {
  /** Disable rate limiting (useful for tests). */
  disableRateLimit?: boolean;
  /** Suppress pino request logging. */
  logger?: boolean;
  /** Skip starting Kraken WS feed (useful for tests). */
  disableKrakenFeed?: boolean;
  /** Skip starting trigger engine (useful for tests). */
  disableTriggerEngine?: boolean;
  /** Skip starting bot runner (useful for tests). */
  disableBotRunner?: boolean;
  /** Skip starting job runner (useful for tests). */
  disableJobRunner?: boolean;
  /** Skip starting outbox worker (useful for tests). */
  disableOutboxWorker?: boolean;
  /** Disable load shedding (useful for tests). */
  disableLoadShedding?: boolean;
}

export async function buildApp(opts: BuildAppOptions = {}) {
  const app = Fastify({
    logger: opts.logger ?? true,
    genReqId: (req) => (req.headers["x-request-id"] as string) || randomUUID(),
  });

  // ── Echo X-Request-Id on every response ──
  app.addHook("onSend", async (req, reply) => {
    reply.header("X-Request-Id", req.id);
  });

  // ── Shared plugins ──
  await app.register(cookie);

  // Helmet: security headers (register before CORS so both coexist)
  await app.register(helmet, {
    contentSecurityPolicy: false, // API-only server; no HTML to protect
  });

  // CORS: env-based origins for production, localhost defaults for dev
  const corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
    : ["http://localhost:5173", "http://localhost:3000"];

  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id"],

  });

  // Rate limiting: global defaults + per-route overrides in route modules
  if (!opts.disableRateLimit) {
    await app.register(rateLimit, {
      max: 100,        // default: 100 requests per window
      timeWindow: 60_000, // 1-minute window
    });
  }

  await app.register(jwt, {
    secret: config.jwtAccessSecret,
  });

  // ── Observability ──
  await app.register(metricsPlugin);

  // ── Load shedding hook (after metrics so inflight gauge is already incremented) ──
  if (config.loadSheddingEnabled && !opts.disableLoadShedding) {
    app.addHook("onRequest", async (req, reply) => {
      const route = req.routeOptions?.url ?? req.url;
      const state = getCurrentLoadState();

      loadStateOverloadedGauge.set(state.isOverloaded ? 1 : 0);

      const priority = getRoutePriority(req.method, route);
      const result = evaluateRequestPolicy(req.method, priority, state);

      if (result.decision === PolicyDecision.REJECT_TEMPORARILY) {
        loadSheddingRejectionsTotal.inc({ reason: result.reason! });
        priorityRejectionTotal.inc({ priority });
        req.log.warn({
          eventType: "load_shedding.reject",
          reason: result.reason,
          priority,
          route,
          method: req.method,
          dbPoolWaiting: state.dbPoolWaitingCount,
          inflightRequests: state.inflightRequests,
        }, `Load shedding: rejected ${req.method} ${route} (${result.reason})`);

        reply.code(503).send({
          error: {
            code: "SYSTEM_OVERLOADED",
            message: "System under high load. Please retry shortly.",
            details: { reason: result.reason },
          },
        });
        return;
      }
    });
  }

  // ── Route modules ──
  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(adminRoutes, { prefix: "/admin" });
  await app.register(walletRoutes);
  await app.register(tradingRoutes);
  await app.register(marketRoutes);
  await app.register(replayRoutes, { prefix: "/replay" });
  await app.register(analyticsRoutes);
  await app.register(riskRoutes, { prefix: "/risk" });
  await app.register(v1Routes, { prefix: "/v1" });

  // -- Kraken live feed --
  if (!opts.disableKrakenFeed) {
    app.addHook("onReady", () => { startKrakenFeed(); });
  }

  // -- Trigger engine --
  if (!opts.disableTriggerEngine) {
    app.addHook("onReady", () => { startTriggerEngine(); });
  }

  // -- Bot runner --
  if (!opts.disableBotRunner) {
    app.addHook("onReady", () => { initBotRunner(); });
  }

  // -- Job runner --
  if (!opts.disableJobRunner) {
    app.addHook("onReady", async () => {
        registerJobs(allJobs);
        await startJobRunner();
    });
  }

  // -- Outbox worker --
  if (!opts.disableOutboxWorker) {
    app.addHook("onReady", () => { startOutboxWorker(); });
  }

  // -- Lock contention sampler --
  app.addHook("onReady", () => { startLockSampler(); });

  return app;
}
