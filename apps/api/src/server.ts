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
import { stopCoinbaseFeed } from "./feeds/coinbaseWs";
import { stopFootprintAggregator } from "./services/footprintAggregator";
import { stopTriggerEngine } from "./triggers/triggerEngine";
import { shutdownQueues } from "./queue/queueManager";
import { runMigrationGuard, getDbVersion } from "./db/migrationGuard";
import { getWorkerDisableFlags, startOrchestrator, stopOrchestrator } from "./coordination/jobOrchestrator";
import { initRedis, shutdownRedis } from "./db/redis";
import { startEventBus, stopEventBus } from "./events/eventBus";
import { initRedisQueue } from "./queue/redisQueue";
import { initEmailTransport } from "./email/emailTransport";
import { initPerpetualBasis, stopPerpetualBasis } from "./market/perpetualBasisService";
import { initOrderBookAggregator, stopOrderBookAggregator } from "./market/orderBookAggregator";
import { initMacroCorrelation, stopMacroCorrelation } from "./market/macroCorrelationService";
import { initOptionsGamma, stopOptionsGamma } from "./market/optionsGammaService";
import { initOnChainFlow, stopOnChainFlow } from "./market/onChainFlowService";
import { initRegimeClassifier, stopRegimeClassifier } from "./market/regimeClassifier";
import { initOutcomeTracker, stopOutcomeTracker } from "./market/outcomeTracker";

function getGitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function start() {
  // ── Optional boot-time migrations (single designated instance) ──
  if (config.runMigrationsOnBoot) {
    console.log("[boot] Running pending migrations…");
    const { runPendingMigrations } = await import("./db/migrate");
    await runPendingMigrations(pool);
  }

  // ── Redis (optional — distributed mode) ──
  try {
    await initRedis();
    await startEventBus();
    await initRedisQueue();
  } catch (err) {
    console.error("[boot] Redis/EventBus init failed (non-fatal):", (err as Error).message);
    // Continue without Redis — local-only mode
  }
  initEmailTransport();

  // ── Migration guard — fail fast if schema mismatch ──
  console.log("[boot] Running migration guard…");
  await runMigrationGuard(pool);

  const app = await buildApp({
    disableRateLimit: config.disableRateLimit,
    ...getWorkerDisableFlags(),
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
    instanceId: config.instanceId,
    instanceRole: config.instanceRole,
    devMode: {
      disableRateLimit: config.disableRateLimit,
      disableJobRunner: config.disableJobRunner,
    },
  });

  // ── Start orchestrator (leader election for background jobs) ──
  await startOrchestrator();

  // ── Graceful shutdown ──
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "Shutdown signal received, closing server…");
    await stopOrchestrator();
    await stopEventBus();
    stopTriggerEngine();
    stopKrakenFeed();
    stopCoinbaseFeed();
    stopFootprintAggregator();
    stopPerpetualBasis();
    stopOrderBookAggregator();
    stopMacroCorrelation();
    stopOptionsGamma();
    stopOnChainFlow();
    stopRegimeClassifier();
    stopOutcomeTracker();
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
    try {
      await shutdownRedis();
      app.log.info("Redis disconnected");
    } catch (err) {
      app.log.error({ err }, "Error disconnecting Redis");
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // ── Start ──
  const port = config.port;
  const host = config.host;

  await app.listen({ port, host });

  // ── Start market data polling ──
  initPerpetualBasis();
  initOrderBookAggregator();
  initMacroCorrelation();
  initOptionsGamma();
  initOnChainFlow();
  initRegimeClassifier();

  // Phase 4 adaptive learning — non-critical, must never crash core server
  try {
    initOutcomeTracker();
  } catch (err) {
    console.warn("[Phase4] OutcomeTracker failed to init:", (err as Error).message);
  }
}

start().catch((err) => {
  console.error("[boot] FATAL — server failed to start:");
  console.error(err);
  process.exit(1);
});
