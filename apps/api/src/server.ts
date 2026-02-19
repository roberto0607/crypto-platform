/**
 * server.ts — Fastify API Entry Point
 *
 * Boots the HTTP server, registers health-check routes, and binds to the
 * configured host/port. This is the main process for the API service.
 *
 * Startup order:
 *   1. dotenv/config loads .env into process.env
 *   2. pool.ts is imported → PG connection pool reads DATABASE_URL
 *   3. Fastify instance is created with structured (pino) logging
 *   4. Routes are registered
 *   5. Server listens; on failure, logs and exits with code 1
 */

import "dotenv/config";
import { pool } from "./db/pool";
import Fastify from 'fastify';

const app = Fastify({ logger: true });

// Liveness probe — confirms the API process is running.
// Does NOT check downstream dependencies.
app.get("/health", async () => {
    return { ok: true, service: "api", timestamp: new Date().toISOString() };
});

// Readiness probe — confirms the API can reach PostgreSQL.
// Useful for orchestrators (Docker, k8s) to gate traffic.
app.get("/health/db", async () => {
  const res = await pool.query("select 1 as ok");
  return { ok: res.rows[0]?.ok === 1 };
});

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";

app.listen({ port, host }).catch((err) => {
    app.log.error(err);
    process.exit(1);

});