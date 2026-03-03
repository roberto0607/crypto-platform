/**
 * server.ts — Fastify API Entry Point
 *
 * Startup order:
 *   1. dotenv/config loads .env into process.env (via config import)
 *   2. pool.ts is imported → PG connection pool reads DATABASE_URL
 *   3. runMigrationGuard() — exits if DB/code schema mismatch
 *   4. buildApp() creates Fastify with all plugins + routes
 *   5. Startup banner logged (version, migration, git commit, DB host)
 *   6. Signal handlers registered for graceful shutdown
 *   7. Server listens; on failure, logs and exits with code 1
 */

import { execSync } from "node:child_process";
import { config } from "./config";
import { pool } from "./db/pool";
import { buildApp } from "./app";
import { stopKrakenFeed } from "./market/krakenWs";
import { stopTriggerEngine } from "./triggers/triggerEngine";
import { stop as stopJobRunner } from "./jobs/jobRunner";
import { shutdownQueues } from "./queue/queueManager";
import { runMigrationGuard, getDbVersion } from "./db/migrationGuard";
import { stopLockSampler } from "./observability/lockSampler";

function getGitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function start() {
  // ── Migration guard — fail fast if schema mismatch ──
  await runMigrationGuard(pool);

  const app = await buildApp({
    disableRateLimit: config.disableRateLimit,
    disableJobRunner: config.disableJobRunner,
  });

  // ── Startup banner ──
  const dbVersion = await getDbVersion(pool);
  const gitCommit = getGitCommit();
  const dbHost = (process.env.DATABASE_URL ?? "")
    .replace(/:[^:@]*@/, ":***@")
    .replace(/\/[^/]*$/, "");

  app.log.info({
    msg: "Server starting",
    appVersion: "1.0.0",
    migrationVersion: dbVersion ?? "(empty)",
    gitCommit,
    dbHost,
    nodeEnv: config.nodeEnv,
  });

  // ── Graceful shutdown ──
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "Shutdown signal received, closing server…");
    stopLockSampler();
    stopTriggerEngine();
    stopKrakenFeed();
    await stopJobRunner();
    await shutdownQueues(10_000);
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
