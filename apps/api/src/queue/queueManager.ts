import { config } from "../config";
import { AppError } from "../errors/AppError";
import { placeOrderWithSnapshot } from "../trading/phase6OrderService";
import type { PlaceOrderResult } from "../trading/phase6OrderService";
import { pairQueueDepth, pairQueueRejectionsTotal } from "../metrics";
import type { PairQueue, QueueJob, QueueStats } from "./queueTypes";
import { createPairQueue, enqueue, processLoop } from "./pairQueue";

const queues = new Map<string, PairQueue>();
let accepting = true;

function getOrCreate(pairId: string): PairQueue {
  let pq = queues.get(pairId);
  if (!pq) {
    pq = createPairQueue();
    queues.set(pairId, pq);
  }
  return pq;
}

async function executor(job: QueueJob): Promise<PlaceOrderResult> {
  return placeOrderWithSnapshot(
    job.userId,
    job.payload,
    job.idempotencyKey,
    job.requestId,
  );
}

export function enqueueOrder(
  pairId: string,
  userId: string,
  payload: QueueJob["payload"],
  idempotencyKey: string | undefined,
  requestId: string,
  timeoutMs?: number,
): Promise<PlaceOrderResult> {
  if (!accepting) {
    throw new AppError("server_shutting_down");
  }

  const pq = getOrCreate(pairId);

  if (pq.jobs.length >= config.maxQueueDepth) {
    pairQueueRejectionsTotal.inc({ pairId });
    throw new AppError("pair_queue_overloaded", {
      pairId,
      depth: pq.jobs.length,
    });
  }

  const jobPromise = new Promise<PlaceOrderResult>((resolve, reject) => {
    const job: QueueJob = {
      requestId,
      userId,
      pairId,
      payload,
      idempotencyKey,
      enqueuedAt: Date.now(),
      resolve,
      reject,
    };

    enqueue(pq, job);
    pairQueueDepth.set({ pairId }, pq.jobs.length);
  });

  // Kick the worker loop (fire-and-forget).
  // processLoop returns immediately if already running.
  void processLoop(pq, executor).then(() => {
    pairQueueDepth.set({ pairId }, pq.jobs.length);
  });

  const timeout = timeoutMs ?? config.queueTimeoutMs;

  // Race the job promise against a timeout.
  // If timeout wins, the client gets 503 but the job keeps executing.
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    setTimeout(() => {
      reject(new AppError("queue_timeout"));
    }, timeout);
  });

  return Promise.race([jobPromise, timeoutPromise]);
}

export function getQueueStats(): QueueStats[] {
  const stats: QueueStats[] = [];
  for (const [pairId, pq] of queues) {
    if (pq.jobs.length === 0 && !pq.running) continue;
    stats.push({
      pairId,
      depth: pq.jobs.length,
      running: pq.running,
      oldestAgeMs:
        pq.jobs.length > 0 ? Date.now() - pq.jobs[0].enqueuedAt : null,
    });
  }
  return stats;
}

export async function shutdownQueues(
  timeoutMs: number = 10_000,
): Promise<void> {
  accepting = false;

  // Wait for all running loops to drain, with a timeout guard.
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let anyRunning = false;
    for (const pq of queues.values()) {
      if (pq.running) {
        anyRunning = true;
        break;
      }
    }
    if (!anyRunning) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  // Reject any remaining queued jobs that never started.
  for (const pq of queues.values()) {
    while (pq.jobs.length > 0) {
      const job = pq.jobs.shift()!;
      job.reject(new AppError("server_shutting_down"));
    }
  }
}

export function isAccepting(): boolean {
  return accepting;
}
