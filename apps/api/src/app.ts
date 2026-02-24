/**
 * app.ts — Fastify app factory.
 *
 * Exports buildApp() which creates and configures the Fastify instance
 * without listening. Used by server.ts (production) and tests.
 */

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

export interface BuildAppOptions {
  /** Disable rate limiting (useful for tests). */
  disableRateLimit?: boolean;
  /** Suppress pino request logging. */
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOptions = {}) {
  const app = Fastify({ logger: opts.logger ?? true });

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
    allowedHeaders: ["Content-Type", "Authorization"],
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

  // ── Route modules ──
  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(adminRoutes, { prefix: "/admin" });
  await app.register(walletRoutes);
  await app.register(tradingRoutes);

  return app;
}
