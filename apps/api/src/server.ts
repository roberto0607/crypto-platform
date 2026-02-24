/**
 * server.ts — Fastify API Entry Point
 *
 * Boots the HTTP server, registers shared plugins (cookie, CORS, JWT),
 * registers route modules, and binds to the configured host/port.
 *
 * Startup order:
 *   1. dotenv/config loads .env into process.env (via config import)
 *   2. pool.ts is imported → PG connection pool reads DATABASE_URL
 *   3. Fastify instance is created with structured (pino) logging
 *   4. Shared plugins registered (cookie, CORS, JWT)
 *   5. Route modules registered
 *   6. Server listens; on failure, logs and exits with code 1
 */

import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
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

  // TODO: tighten origins for production (use env-based allowlist)
  await app.register(cors, {
    origin: ["http://localhost:5173", "http://localhost:3000"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
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
