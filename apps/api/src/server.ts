/**
 * server.ts — Fastify API Entry Point
 *
 * Imports buildApp() from app.ts, adds graceful shutdown handlers,
 * and starts listening on the configured host/port.
 *
 * Startup order:
 *   1. dotenv/config loads .env into process.env (via config import)
 *   2. pool.ts is imported → PG connection pool reads DATABASE_URL
 *   3. buildApp() creates Fastify with all plugins + routes
 *   4. Signal handlers registered for graceful shutdown
 *   5. Server listens; on failure, logs and exits with code 1
 */

import { config } from "./config";
import { pool } from "./db/pool";
import { buildApp } from "./app";
import { stopKrakenFeed } from "./market/krakenWs";
import { stopTriggerEngine } from "./triggers/triggerEngine";

async function start() {
  const app = await buildApp();

  // ── Graceful shutdown ──
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "Shutdown signal received, closing server…");
    stopTriggerEngine();
    stopKrakenFeed();
    try {
      await app.close();
      app.log.info("Fastify closed");
    } catch (err) {
      app.log.error({ err }, "Error closing Fastify");
    }
    try {
      await pool.end();
      app.log.info("PG pool drained");
    } catch (err) {
      app.log.error({ err }, "Error draining PG pool");
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // ── Start ──
  const port = config.port;
  const host = config.host;

  await app.listen({ port, host });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
