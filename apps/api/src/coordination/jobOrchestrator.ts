/**
 * jobOrchestrator.ts — Role-based background job orchestration.
 *
 * Controls which background jobs start based on INSTANCE_ROLE:
 *   - API:    No background jobs (HTTP serving only)
 *   - WORKER: Leader election for outbox, job runner, lock sampler
 *   - ALL:    Same as WORKER (leader election still applies for multi-instance safety)
 *
 * Each job acquires a dedicated advisory lock before starting.
 * If the lock is held by another instance, retries every RETRY_INTERVAL_MS.
 * On shutdown, releases all locks and stops all running jobs.
 */

import { pool } from "../db/pool";
import { config } from "../config";
import {
  tryAcquireLeadership,
  releaseAllLeadership,
  isLeader,
  LOCK_NAMES,
} from "./leaderElection";
import { startOutboxWorker } from "../outbox/outboxWorker";
import { registerJobs, start as startJobRunner, stop as stopJobRunner } from "../jobs/jobRunner";
import { allJobs } from "../jobs/definitions/index";
import { startLockSampler, stopLockSampler } from "../observability/lockSampler";
import { logger as rootLogger } from "../observability/logContext";

const logger = rootLogger.child({ module: "jobOrchestrator" });

const RETRY_INTERVAL_MS = 5_000;

let retryTimer: ReturnType<typeof setInterval> | null = null;
let outboxHandle: { stop: () => void } | null = null;
let jobRunnerStarted = false;
let lockSamplerStarted = false;

function shouldRunWorker(): boolean {
  if (config.disableJobRunner) return false;
  return config.instanceRole === "WORKER" || config.instanceRole === "ALL";
}

/**
 * Returns BuildAppOptions flags to disable background jobs in app.ts.
 * The orchestrator takes over starting them via leader election.
 */
export function getWorkerDisableFlags(): {
  disableJobRunner: boolean;
  disableOutboxWorker: boolean;
  disableLockSampler: boolean;
} {
  return {
    disableJobRunner: true,
    disableOutboxWorker: true,
    disableLockSampler: true,
  };
}

/**
 * Try to acquire leadership for each job and start the ones we win.
 */
async function electAndStart(): Promise<void> {
  // ── Outbox worker ──
  if (!isLeader(LOCK_NAMES.outbox) && !outboxHandle) {
    const acquired = await tryAcquireLeadership(pool, LOCK_NAMES.outbox);
    if (acquired) {
      outboxHandle = startOutboxWorker();
      logger.info("Orchestrator: outbox worker started (leader)");
    }
  }

  // ── Job runner (reconciliation + all scheduled jobs) ──
  if (!isLeader(LOCK_NAMES.reconciliation) && !jobRunnerStarted) {
    const acquired = await tryAcquireLeadership(pool, LOCK_NAMES.reconciliation);
    if (acquired) {
      registerJobs(allJobs);
      await startJobRunner();
      jobRunnerStarted = true;
      logger.info("Orchestrator: job runner started (leader)");
    }
  }

  // ── Lock sampler ──
  if (config.lockSamplerEnabled && !isLeader(LOCK_NAMES.lockSampler) && !lockSamplerStarted) {
    const acquired = await tryAcquireLeadership(pool, LOCK_NAMES.lockSampler);
    if (acquired) {
      startLockSampler();
      lockSamplerStarted = true;
      logger.info("Orchestrator: lock sampler started (leader)");
    }
  }
}

/**
 * Start the orchestrator. Call after Fastify is ready.
 */
export async function startOrchestrator(): Promise<void> {
  if (!shouldRunWorker()) {
    logger.info(
      { instanceId: config.instanceId, role: config.instanceRole },
      "Orchestrator: skipping worker duties (API-only role)",
    );
    return;
  }

  logger.info(
    { instanceId: config.instanceId, role: config.instanceRole },
    "Orchestrator: starting leader election loops",
  );

  // Immediate first attempt
  await electAndStart();

  // Periodic retry for locks not yet acquired
  retryTimer = setInterval(async () => {
    try {
      await electAndStart();
    } catch (err) {
      logger.error({ err }, "Orchestrator: election tick failed");
    }
  }, RETRY_INTERVAL_MS);
  retryTimer.unref();
}

/**
 * Stop the orchestrator — stops all running jobs and releases all locks.
 */
export async function stopOrchestrator(): Promise<void> {
  // Stop retry loop
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }

  // Stop workers in reverse start order
  if (lockSamplerStarted) {
    stopLockSampler();
    lockSamplerStarted = false;
  }

  if (jobRunnerStarted) {
    await stopJobRunner();
    jobRunnerStarted = false;
  }

  if (outboxHandle) {
    outboxHandle.stop();
    outboxHandle = null;
  }

  // Release all advisory locks
  await releaseAllLeadership();

  logger.info("Orchestrator stopped");
}
