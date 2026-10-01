/**
 * runLogPolicy.ts — which agent cycles get an agent_run_logs row.
 *
 * Writing one row per cycle (with the model's raw output in metadata) is
 * unbounded growth for no reader: the only consumers are humans debugging
 * a failure and agentHealthWatchdogJob's "last success" lookup. So:
 *
 *   - error / timeout           → always persisted
 *   - success that led to an action (e.g. a trade proposal) → always
 *   - plain success             → persisted if this agent has no persisted
 *                                 success within the heartbeat window
 *                                 (keeps the watchdog truthful), otherwise
 *                                 with probability sampleRate.
 *
 * While the disk-pressure guard is critical (dbSizeGuard.ts), nothing is
 * persisted -- agent logs are the first non-essential write to go.
 *
 * Heartbeat state is per process; a restart simply persists the next
 * success, which is the conservative direction.
 */
import { config } from "../../config";
import { nonEssentialWritesPaused } from "../../observability/writePause";

export interface RunLogCandidate {
  agentName: string;
  status: "success" | "error" | "timeout";
  ledToAction: boolean;
}

export interface RunLogPolicy {
  shouldPersist(run: RunLogCandidate): boolean;
  reset(): void;
}

export function createRunLogPolicy(opts: {
  sampleRate: number;
  heartbeatMs: number;
  now?: () => number;
  random?: () => number;
  paused?: () => boolean;
}): RunLogPolicy {
  const paused = opts.paused ?? nonEssentialWritesPaused;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const lastPersistedSuccess = new Map<string, number>();

  return {
    shouldPersist(run) {
      if (paused()) return false;
      if (run.status !== "success" || run.ledToAction) return true;
      const t = now();
      const last = lastPersistedSuccess.get(run.agentName);
      const persist =
        last === undefined || t - last >= opts.heartbeatMs || random() < opts.sampleRate;
      if (persist) lastPersistedSuccess.set(run.agentName, t);
      return persist;
    },
    reset() {
      lastPersistedSuccess.clear();
    },
  };
}

export const runLogPolicy = createRunLogPolicy({
  sampleRate: config.agentLogSampleRate,
  heartbeatMs: config.agentLogHeartbeatMinutes * 60_000,
});
