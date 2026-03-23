/**
 * redisQueue.ts — Redis Streams-based order queue for multi-instance deployments.
 *
 * Architecture:
 *   1. HTTP handler calls enqueueRedis() → XADD to stream, stores local Promise
 *   2. One consumer per pair (elected via Redis lock) processes serially
 *   3. After processing, result is PUBLISH'd to the originating instance's channel
 *   4. Originating instance resolves the pending Promise
 */

import { randomUUID } from "node:crypto";
import { config } from "../config";
import { AppError } from "../errors/AppError";
import { placeOrderWithSnapshot } from "../trading/phase6OrderService";
import type { PlaceOrderResult } from "../trading/phase6OrderService";
import {
  pairQueueDepth,
  pairQueueRejectionsTotal,
  pairQueueWaitMs,
  pairQueueExecMs,
} from "../metrics";
import { logger } from "../observability/logContext";
import { getRedis, getRedisSub } from "../db/redis.js";
import type { QueueStats } from "./queueTypes";

const GROUP_NAME = "workers";
const LOCK_TTL_S = 30;
const LOCK_RENEW_MS = 10_000;
const READ_BLOCK_MS = 5_000;

let accepting = true;

// ── Pending promise tracking ──

interface PendingEntry {
  resolve: (result: PlaceOrderResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingEntry>();

// ── Active consumer tracking ──

interface ConsumerState {
  lockRenewTimer: ReturnType<typeof setInterval>;
  stopped: boolean;
}

const consumers = new Map<string, ConsumerState>();

// ── Key helpers ──

function streamKey(pairId: string): string {
  return `queue:${pairId}`;
}

/**
 * ioredis keyPrefix ("cp:") is auto-applied to most commands (XADD, XLEN,
 * XTRIM, XREADGROUP, XACK) but NOT to subcommand-style commands where the
 * key sits at position 2+ (XGROUP CREATE key, XINFO GROUPS key).
 * Use this for those commands so the key matches the prefixed stream.
 */
function rawStreamKey(pairId: string): string {
  return `cp:${streamKey(pairId)}`;
}

function lockKeyName(pairId: string): string {
  return `pairlock:${pairId}`;
}

// ── Lua scripts ──

const RENEW_LOCK_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("EXPIRE", KEYS[1], ARGV[2])
  end
  return 0
`;

const RELEASE_LOCK_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

// ── Result listener ──

/**
 * Flush stale messages from all queue streams.
 * Called on boot to clear orphaned orders from previous crashed deployments.
 * Also available via admin endpoint for manual recovery.
 */
export async function flushStaleStreams(): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;

  // Scan for all queue:* streams
  let cursor = "0";
  let totalFlushed = 0;

  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "queue:*", "COUNT", "100");
    cursor = nextCursor;

    for (const key of keys) {
      const len = await redis.xlen(key);
      if (len > 0) {
        // XTRIM to 0 — removes all messages
        await redis.xtrim(key, "MAXLEN", 0);
        logger.info({ stream: key, flushed: len }, "flushed_stale_queue_stream");
        totalFlushed += len;
      }
    }
  } while (cursor !== "0");

  if (totalFlushed > 0) {
    logger.info({ totalFlushed }, "stale_queue_flush_complete");
  }
  return totalFlushed;
}

export async function initRedisQueue(): Promise<void> {
  const sub = getRedisSub();
  if (!sub) return;

  // Flush stale messages from previous deployments on boot
  await flushStaleStreams();

  const channel = `cp:results:${config.instanceId}`;

  sub.on("message", (ch: string, message: string) => {
    if (ch !== channel) return;
    try {
      const parsed = JSON.parse(message);
      const entry = pending.get(parsed.correlationId);
      if (!entry) return;

      pending.delete(parsed.correlationId);
      clearTimeout(entry.timer);

      if (parsed.error) {
        entry.reject(new AppError(parsed.error.code ?? "queue_processing_error"));
      } else {
        entry.resolve(parsed.result);
      }
    } catch (err) {
      logger.warn({ err }, "Failed to process queue result message");
    }
  });

  await sub.subscribe(channel);
}

// ── Enqueue ──

export async function enqueueRedis(
  pairId: string,
  userId: string,
  payload: { pairId: string; side: string; type: string; qty: string; limitPrice?: string },
  idempotencyKey: string | undefined,
  requestId: string,
  timeoutMs?: number,
  competitionId?: string,
): Promise<PlaceOrderResult> {
  if (!accepting) throw new AppError("server_shutting_down");

  const redis = getRedis()!;
  const correlationId = randomUUID();
  const timeout = timeoutMs ?? config.queueTimeoutMs;
  const key = streamKey(pairId);

  // Ensure consumer group exists (idempotent — ignore if already created)
  // NOTE: XGROUP does not get ioredis keyPrefix — use rawStreamKey
  const rawKey = rawStreamKey(pairId);
  try {
    await redis.xgroup("CREATE", rawKey, GROUP_NAME, "0", "MKSTREAM");
    logger.debug({ rawKey, group: GROUP_NAME }, "xgroup_created_in_enqueue");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("BUSYGROUP")) {
      logger.debug({ rawKey, group: GROUP_NAME }, "xgroup_already_exists_in_enqueue");
    } else {
      logger.error({ err, rawKey, group: GROUP_NAME }, "xgroup_create_failed_in_enqueue");
      throw err; // Non-BUSYGROUP error — do not swallow
    }
  }

  // Check queue depth
  const depth = await redis.xlen(key);
  if (depth >= config.maxQueueDepth) {
    pairQueueRejectionsTotal.inc({ pairId });
    throw new AppError("pair_queue_overloaded", { pairId, depth });
  }

  // XADD to stream
  await redis.xadd(
    key, "*",
    "correlationId", correlationId,
    "instanceId", config.instanceId,
    "userId", userId,
    "pairId", pairId,
    "payload", JSON.stringify(payload),
    "idempotencyKey", idempotencyKey ?? "",
    "requestId", requestId,
    "competitionId", competitionId ?? "",
    "enqueuedAt", Date.now().toString(),
  );

  pairQueueDepth.set({ pairId }, depth + 1);

  // Ensure a consumer is running for this pair
  ensureConsumer(pairId);

  // Return a promise that resolves when the result arrives
  return new Promise<PlaceOrderResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(correlationId);
      reject(new AppError("queue_timeout"));
    }, timeout);

    pending.set(correlationId, { resolve, reject, timer });
  });
}

// ── Consumer management ──

function ensureConsumer(pairId: string): void {
  if (consumers.has(pairId)) return;
  void startConsumer(pairId);
}

async function startConsumer(pairId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  // Ensure stream + consumer group exist before anything else
  // NOTE: XGROUP/XINFO do not get ioredis keyPrefix — use rawStreamKey
  const sk = streamKey(pairId);
  const rawKey = rawStreamKey(pairId);
  try {
    await redis.xgroup("CREATE", rawKey, GROUP_NAME, "0", "MKSTREAM");
    logger.info({ pairId, rawKey, group: GROUP_NAME }, "xgroup_created_in_startConsumer");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("BUSYGROUP")) {
      logger.debug({ pairId, rawKey }, "xgroup_already_exists_in_startConsumer");
    } else {
      logger.error({ err, pairId, rawKey, group: GROUP_NAME }, "xgroup_create_failed_in_startConsumer — consumer will NOT start");
      return; // Cannot consume without a group
    }
  }

  // Verify group actually exists before proceeding
  try {
    const groups = await redis.xinfo("GROUPS", rawKey) as unknown[];
    logger.info({ pairId, rawKey, groupCount: groups.length }, "xinfo_groups_before_lock");
  } catch (err) {
    logger.error({ err, pairId, rawKey }, "xinfo_groups_failed — stream may not exist at expected key");
  }

  // Try to acquire per-pair lock
  const locked = await redis.set(lockKeyName(pairId), config.instanceId, "EX", LOCK_TTL_S, "NX");
  if (!locked) return; // Another instance holds the lock

  const state: ConsumerState = {
    stopped: false,
    lockRenewTimer: setInterval(async () => {
      try {
        const result = await redis.eval(
          RENEW_LOCK_SCRIPT, 1,
          lockKeyName(pairId), config.instanceId, LOCK_TTL_S.toString(),
        );
        if (result === 0) {
          state.stopped = true;
        }
      } catch {
        state.stopped = true;
      }
    }, LOCK_RENEW_MS),
  };

  consumers.set(pairId, state);

  try {
    logger.info({ pairId, rawKey, group: GROUP_NAME, consumer: config.instanceId }, "consumer_loop_starting");
    while (!state.stopped && accepting) {
      try {
        const entries = await redis.xreadgroup(
          "GROUP", GROUP_NAME, config.instanceId,
          "COUNT", "1", "BLOCK", READ_BLOCK_MS.toString(),
          "STREAMS", sk, ">",
        ) as [string, [string, string[]][]][] | null;

        if (!entries || entries.length === 0) continue;

        for (const [, messages] of entries) {
          for (const [msgId, fields] of messages) {
            const job = parseFields(fields);
            await processJob(redis, pairId, msgId, job);
          }
        }
      } catch (err) {
        if (state.stopped || !accepting) break;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("NOGROUP")) {
          logger.error({ err, pairId, rawKey, group: GROUP_NAME }, "NOGROUP in xreadgroup — group missing despite prior xgroup create");
          // Attempt recovery: re-create group using raw key (no ioredis prefix)
          try {
            await redis.xgroup("CREATE", rawKey, GROUP_NAME, "0", "MKSTREAM");
            logger.info({ pairId, rawKey }, "xgroup_recreated_after_nogroup");
          } catch (recreateErr: unknown) {
            const rm = recreateErr instanceof Error ? recreateErr.message : String(recreateErr);
            if (!rm.includes("BUSYGROUP")) {
              logger.error({ err: recreateErr, pairId, rawKey }, "xgroup_recreate_also_failed");
              break; // Cannot recover
            }
          }
        } else {
          logger.error({ err, pairId }, "Queue consumer error, retrying…");
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  } finally {
    clearInterval(state.lockRenewTimer);
    consumers.delete(pairId);

    // Release lock if we still hold it
    try {
      await redis.eval(
        RELEASE_LOCK_SCRIPT, 1,
        lockKeyName(pairId), config.instanceId,
      );
    } catch {
      // Shutting down
    }
  }
}

async function processJob(
  redis: ReturnType<typeof getRedis> & object,
  pairId: string,
  msgId: string,
  job: Record<string, string>,
): Promise<void> {
  const execStart = Date.now();
  const enqueuedAt = parseInt(job.enqueuedAt, 10);

  try {
    const result = await placeOrderWithSnapshot(
      job.userId,
      JSON.parse(job.payload),
      job.idempotencyKey || undefined,
      job.requestId,
      job.competitionId || undefined,
    );

    pairQueueWaitMs.observe({ pairId }, execStart - enqueuedAt);
    pairQueueExecMs.observe({ pairId }, Date.now() - execStart);

    await redis.publish(`cp:results:${job.instanceId}`, JSON.stringify({
      correlationId: job.correlationId,
      result,
    }));
  } catch (err) {
    pairQueueWaitMs.observe({ pairId }, execStart - enqueuedAt);
    pairQueueExecMs.observe({ pairId }, Date.now() - execStart);

    await redis.publish(`cp:results:${job.instanceId}`, JSON.stringify({
      correlationId: job.correlationId,
      error: {
        code: err instanceof AppError ? err.message : "queue_processing_error",
      },
    }));
  }

  // ACK + update depth metric
  await redis.xack(streamKey(pairId), GROUP_NAME, msgId);
  const depth = await redis.xlen(streamKey(pairId));
  pairQueueDepth.set({ pairId }, depth);
}

function parseFields(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj;
}

// ── Stats ──

export async function getRedisQueueStats(): Promise<QueueStats[]> {
  const redis = getRedis();
  if (!redis) return [];

  const stats: QueueStats[] = [];
  for (const pairId of consumers.keys()) {
    try {
      const depth = await redis.xlen(streamKey(pairId));
      stats.push({ pairId, depth, running: true, oldestAgeMs: null });
    } catch {
      // Skip
    }
  }
  return stats;
}

// ── Shutdown ──

export async function shutdownRedisQueue(timeoutMs: number = 10_000): Promise<void> {
  accepting = false;

  // Signal all consumers to stop
  for (const state of consumers.values()) {
    state.stopped = true;
  }

  // Wait for consumers to drain
  const deadline = Date.now() + timeoutMs;
  while (consumers.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  // Reject all pending promises
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new AppError("server_shutting_down"));
    pending.delete(id);
  }

  // Unsubscribe from result channel
  const sub = getRedisSub();
  if (sub) {
    try {
      await sub.unsubscribe(`cp:results:${config.instanceId}`);
    } catch {
      // Already disconnecting
    }
  }
}
