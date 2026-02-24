/**
 * server.ts — Fastify API Entry Point
 *
 * Boots the HTTP server, registers shared plugins (cookie, CORS, JWT,
 * helmet, rate-limit), registers route modules, and binds to the
 * configured host/port.
 *
 * Startup order:
 *   1. dotenv/config loads .env into process.env (via config import)
 *   2. pool.ts is imported → PG connection pool reads DATABASE_URL
 *   3. Fastify instance is created with structured (pino) logging
 *   4. Shared plugins registered (cookie, helmet, CORS, rate-limit, JWT)
 *   5. Route modules registered
 *   6. Server listens; on failure, logs and exits with code 1
 */

import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import jwt from "@fastify/jwt";

import { config } from "./config";

import healthRoutes from "./routes/healthRoutes";
import authRoutes from "./routes/authRoutes";
import adminRoutes from "./routes/adminRoutes";
import walletRoutes from "./routes/walletRoutes";
import tradingRoutes from "./routes/tradingRoutes";

async function start() {
  const app = Fastify({ logger: true });

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
  await app.register(rateLimit, {
    max: 100,        // default: 100 requests per window
    timeWindow: 60_000, // 1-minute window
  });

  await app.register(jwt, {
    secret: config.jwtAccessSecret,
  });

  // ── Route modules ──
  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(adminRoutes, { prefix: "/admin" });
  await app.register(walletRoutes);
  await app.register(tradingRoutes);

  // ── Start ──
  const port = config.port;
  const host = config.host;

  await app.listen({ port, host });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
