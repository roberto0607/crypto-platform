import type { PlaceOrderResult } from "../trading/phase6OrderService";
import type { PairQueue, QueueJob } from "./queueTypes";
import { pairQueueWaitMs, pairQueueExecMs } from "../metrics";

export function createPairQueue(): PairQueue {
  return { jobs: [], running: false };
}

export function enqueue(pq: PairQueue, job: QueueJob): void {
  pq.jobs.push(job);
}

export async function processLoop(
  pq: PairQueue,
  executor: (job: QueueJob) => Promise<PlaceOrderResult>,
): Promise<void> {
  if (pq.running) return;
  pq.running = true;
  try {
    while (pq.jobs.length > 0) {
      const job = pq.jobs.shift()!;
      const start = Date.now();
      try {
        const result = await executor(job);
        pairQueueWaitMs.observe({ pairId: job.pairId }, start - job.enqueuedAt);
        pairQueueExecMs.observe({ pairId: job.pairId }, Date.now() - start);
        job.resolve(result);
      } catch (err) {
        pairQueueWaitMs.observe({ pairId: job.pairId }, start - job.enqueuedAt);
        pairQueueExecMs.observe({ pairId: job.pairId }, Date.now() - start);
        job.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  } finally {
    pq.running = false;
  }
}
