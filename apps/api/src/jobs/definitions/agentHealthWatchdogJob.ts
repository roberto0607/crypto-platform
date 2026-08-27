import type { JobDefinition } from "../jobTypes";
import type { Pool } from "pg";
import { config } from "../../config";

const UNHEALTHY_THRESHOLD_MS = 90 * 60 * 1000;
// News Agent's own cadence is 10 min (vs Scanner's 30 min / Chart
// Analysis's event-driven-off-Scanner cadence), so the same headroom
// used for those two would be far too loose here -- 90 min of silence
// would mean 9 missed News Agent cycles before paging. ~3.5x its own
// interval instead, matching the same ratio of headroom.
const NEWS_AGENT_UNHEALTHY_THRESHOLD_MS = 35 * 60 * 1000;

interface WatchedAgent {
  name: string;
  isEnabled: () => boolean;
  thresholdMs: number;
  /** Timestamp of this agent's last confirmed-real success, or null if
   *  it has never succeeded. What "real success" means is per-agent --
   *  see the two implementations below. */
  getLastSuccessAt: (pool: Pool) => Promise<Date | null>;
}

/**
 * Scanner/Chart Analysis's shared source: agent_run_logs, the one place
 * both agents write a real per-attempt status (see runner.ts's logRun()
 * in scanner/ and chartAnalysis/). job_runs.last_status only means "the
 * wrapper didn't throw" -- see file header -- so it's deliberately not
 * used here.
 */
async function lastAgentRunLogSuccess(pool: Pool, agentName: string): Promise<Date | null> {
  const { rows } = await pool.query<{ created_at: Date }>(
    `SELECT created_at FROM agent_run_logs
     WHERE agent_name = $1 AND status = 'success'
     ORDER BY created_at DESC LIMIT 1`,
    [agentName],
  );
  return rows[0]?.created_at ?? null;
}

/**
 * News Agent (Gate 1f) has no agent_run_logs row at all -- it's a job,
 * not an LLM decision-cycle agent (see newsAgentJob.ts's own header).
 * job_runs is not trusted for the same reason as scanner/chart-analysis
 * above: run() completes normally (job_runs=SUCCESS) even when the API
 * key is missing (warn-and-return) or every batch fetch fails (each
 * caught individually inside the loop, which continues) -- neither
 * actually refreshes a flag. pair_news_flags.updated_at is the job's
 * real deliverable, upserted only after a genuinely successful batch
 * fetch (see upsertFlag/fetchBatchFlags) -- MAX(updated_at) only
 * advances on a real write, same "time since last real success"
 * philosophy as lastAgentRunLogSuccess above, sourced from the table
 * this specific job owns instead.
 */
async function lastNewsAgentFlagUpdate(pool: Pool): Promise<Date | null> {
  const { rows } = await pool.query<{ max: Date | null }>(
    `SELECT MAX(updated_at) AS max FROM pair_news_flags`,
  );
  return rows[0]?.max ?? null;
}

/**
 * Agent health watchdog (job-observability fix, 2026-08-11; extended
 * for News Agent, Gate 1f).
 *
 * Time-since-last-success, not count/rate-based: Chart Analysis only
 * fires when Scanner produces a candidate. If Scanner goes silent,
 * Chart Analysis doesn't accumulate failed attempts -- it just never
 * gets invoked, so a "last N attempts failed" check would see nothing
 * wrong. "No success in the last N minutes" is the one metric that
 * catches both "failing every attempt" and "not being invoked at all".
 *
 * Only agents with a getLastSuccessAt path that reflects REAL success,
 * not wrapper-didn't-throw. Skips an agent entirely (no query issued)
 * when its own config flag is off -- all three flags default false, and
 * an intentionally-disabled agent must never page as "unhealthy".
 */
const WATCHED_AGENTS: WatchedAgent[] = [
  {
    name: "scanner",
    isEnabled: () => config.scannerAgentEnabled,
    thresholdMs: UNHEALTHY_THRESHOLD_MS,
    getLastSuccessAt: (pool) => lastAgentRunLogSuccess(pool, "scanner"),
  },
  {
    name: "chart-analysis",
    isEnabled: () => config.chartAnalysisAgentEnabled,
    thresholdMs: UNHEALTHY_THRESHOLD_MS,
    getLastSuccessAt: (pool) => lastAgentRunLogSuccess(pool, "chart-analysis"),
  },
  {
    name: "news-agent",
    isEnabled: () => config.newsAgentEnabled,
    thresholdMs: NEWS_AGENT_UNHEALTHY_THRESHOLD_MS,
    getLastSuccessAt: lastNewsAgentFlagUpdate,
  },
];

export const agentHealthWatchdogJob: JobDefinition = {
  name: "agent-health-watchdog",
  intervalSeconds: 300,
  timeoutMs: 15_000,
  async run(ctx) {
    for (const agent of WATCHED_AGENTS) {
      if (!agent.isEnabled()) continue;

      const lastSuccessAt = await agent.getLastSuccessAt(ctx.pool);
      const sinceMs = lastSuccessAt ? Date.now() - new Date(lastSuccessAt).getTime() : null;

      if (sinceMs === null || sinceMs > agent.thresholdMs) {
        ctx.logger.error(
          {
            agentName: agent.name,
            lastSuccessAt: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : null,
            minutesSinceLastSuccess: sinceMs === null ? null : Math.round(sinceMs / 60_000),
          },
          "agent_health_watchdog_unhealthy",
        );
      }
    }
  },
};
