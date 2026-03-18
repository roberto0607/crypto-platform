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
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

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
import betaAdminRoutes from "./routes/betaAdminRoutes";
import statusRoutes from "./routes/statusRoutes";
import apiKeyRoutes from "./routes/apiKeyRoutes";
import basisRoutes from "./routes/basisRoutes";
import krakenBookRoutes from "./routes/krakenBookRoutes";
import orderBookSignalRoutes from "./routes/orderBookSignalRoutes";
import macroRoutes from "./routes/macroRoutes";
import gammaRoutes from "./routes/gammaRoutes";
import onChainRoutes from "./routes/onChainRoutes";
import signalRoutes from "./routes/signalRoutes";
import regimeRoutes from "./routes/regimeRoutes";
import intelligenceRoutes from "./routes/intelligenceRoutes";
import learningRoutes from "./routes/learningRoutes";
import { startKrakenFeed } from "./market/krakenWs"
import { startCoinbaseFeed } from "./feeds/coinbaseWs"
import { startTriggerEngine } from "./triggers/triggerEngine";
import { initBotRunner } from "./bot/botRunner";
import { registerJobs, start as startJobRunner } from "./jobs/jobRunner";
import { allJobs } from "./jobs/definitions/index";
import { startOutboxWorker } from "./outbox/outboxWorker";
import { startLockSampler } from "./observability/lockSampler";

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
  /** Skip starting lock sampler (orchestrator manages it). */
  disableLockSampler?: boolean;
  /** Disable orchestrator (useful for scripts). */
  disableOrchestrator?: boolean;
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
    frameguard: { action: "deny" }, // X-Frame-Options: DENY
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  });

  // CORS: env-based origins for production, localhost defaults for dev
  const corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
    : ["http://localhost:5173", "http://localhost:3000"];

  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id", "X-Api-Key"],

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
    sign: {
      iss: "crypto-platform",
      aud: "crypto-platform-api",
    },
    verify: {
      allowedIss: "crypto-platform",
      allowedAud: "crypto-platform-api",
    },
  });

  // ── OpenAPI / Swagger (register BEFORE routes) ──
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Crypto Platform API",
        description: "Cryptocurrency trading platform — REST API documentation",
        version: "1.0.0",
      },
      servers: [
        { url: "http://localhost:3001", description: "Development" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "JWT access token from POST /auth/login",
          },
          apiKey: {
            type: "apiKey",
            in: "header",
            name: "Authorization",
            description: "API key: 'ApiKey <your-key>'",
          },
          cookieAuth: {
            type: "apiKey",
            in: "cookie",
            name: "refresh_token",
            description: "HttpOnly refresh token cookie (set by login)",
          },
        },
      },
      tags: [
        { name: "Auth", description: "Authentication — register, login, refresh, logout" },
        { name: "Users", description: "User profile and management" },
        { name: "Wallets", description: "Wallet balances and transactions" },
        { name: "Trading", description: "Order placement and management" },
        { name: "Pairs", description: "Trading pair configuration and order books" },
        { name: "Assets", description: "Asset definitions" },
        { name: "Triggers", description: "Conditional trigger orders (stop-loss, take-profit, OCO)" },
        { name: "Portfolio", description: "Portfolio analytics, equity snapshots, positions" },
        { name: "Bot", description: "Strategy bot runs and signals" },
        { name: "Replay", description: "Historical replay engine" },
        { name: "Risk", description: "Risk status and circuit breakers" },
        { name: "Status", description: "System and user status" },
        { name: "Events", description: "Server-Sent Events (SSE) real-time stream" },
        { name: "Admin", description: "Administrative endpoints (ADMIN role required)" },
        { name: "Health", description: "Health checks and instance info" },
      ],
    },
  });

  if (!config.isProd || config.enableSwaggerUi) {
    await app.register(swaggerUi, {
      routePrefix: "/docs",
      uiConfig: {
        docExpansion: "list",
        deepLinking: true,
        defaultModelsExpandDepth: 3,
        defaultModelExpandDepth: 3,
      },
    });
  }

  // ── Observability ──
  await app.register(metricsPlugin);

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
  await app.register(betaAdminRoutes, { prefix: "/v1/admin" });
  await app.register(statusRoutes, { prefix: "/status" });
  await app.register(apiKeyRoutes, { prefix: "/api-keys" });
  await app.register(basisRoutes);
  await app.register(krakenBookRoutes);
  await app.register(orderBookSignalRoutes);
  await app.register(macroRoutes);
  await app.register(gammaRoutes);
  await app.register(onChainRoutes);
  await app.register(signalRoutes);
  await app.register(regimeRoutes);
  await app.register(intelligenceRoutes);
  await app.register(learningRoutes);

  // ── Error code reference (documentation endpoint) ──
  app.get("/api/errors", {
    schema: {
      tags: ["Status"],
      summary: "Error code reference",
      description: "Returns all possible API error codes and their meanings.",
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            errors: { type: "object" },
          },
        },
      },
    },
  }, async (_req, reply) => {
    return reply.send({
      ok: true,
      errors: {
        // Auth
        invalid_credentials: "Wrong email or password",
        login_blocked: "Too many failed attempts, wait 15 minutes",
        email_taken: "Email already registered",
        invite_required: "Beta mode requires an invite code",
        invite_invalid: "Invalid or expired invite code",
        invalid_or_expired_token: "Verification/reset token is invalid or expired",
        email_not_verified: "Email verification required",

        // Trading
        insufficient_balance: "Not enough available balance",
        risk_check_failed: "Order rejected by risk engine",
        governance_check_failed: "Order rejected by governance check",
        pair_queue_overloaded: "Order queue full, try again shortly",
        trading_paused_global: "Trading is paused system-wide",
        trading_paused_pair: "Trading is paused for this pair",
        quota_exceeded: "Rate or order quota exceeded",
        order_not_found: "Order does not exist",
        order_not_cancelable: "Order is already filled or cancelled",

        // General
        invalid_input: "Request validation failed (check details field)",
        unauthorized: "Authentication required",
        forbidden: "Insufficient permissions",
        not_found: "Resource not found",
        read_only_mode: "System is in read-only maintenance mode",
        idempotency_conflict: "Idempotent request already processed",
      },
    });
  });

  // -- Kraken live feed --
  if (!opts.disableKrakenFeed) {
    app.addHook("onReady", () => { startKrakenFeed(); });
  }

  // -- Coinbase live feed (buy/sell trade flow for CVD) --
  if (!opts.disableKrakenFeed) {
    app.addHook("onReady", () => {
      try { startCoinbaseFeed(); } catch (err) { console.error("[coinbaseWs] failed to start", err); }
    });
  }

  // -- Trigger engine --
  if (!opts.disableTriggerEngine) {
    app.addHook("onReady", async () => { await startTriggerEngine(); });
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

  // -- Lock contention sampler (orchestrator manages this when roles are active) --
  if (!opts.disableLockSampler) {
    app.addHook("onReady", () => { startLockSampler(); });
  }

  return app;
}
