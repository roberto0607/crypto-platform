import type { JobDefinition } from "../jobTypes";
import { config } from "../../config";

const UNHEALTHY_THRESHOLD_MS = 90 * 60 * 1000;

interface WatchedAgent {
  name: string;
  isEnabled: () => boolean;
}

/**
 * Agent health watchdog (job-observability fix, 2026-08-11).
 *
 * job_runs.last_status only means "the wrapper didn't throw" -- both
 * scannerAgentJob (catches every internal failure and returns normally,
 * see its own file comment) and chartAnalysisEngine.ts (event-driven,
 * not a JobDefinition at all -- has no job_runs row whatsoever) can be
 * failing every single attempt while job_runs shows SUCCESS or nothing.
 * agent_run_logs is the one place both agents already write a real
 * per-attempt status (see runner.ts's logRun() in scanner/ and
 * chartAnalysis/) -- this job cross-references it instead of adding new
 * plumbing.
 *
 * Time-since-last-success, not count/rate-based: Chart Analysis only
 * fires when Scanner produces a candidate. If Scanner goes silent,
 * Chart Analysis doesn't accumulate failed attempts -- it just never
 * gets invoked, so a "last N attempts failed" check would see nothing
 * wrong. "No success in the last N minutes" is the one metric that
 * catches both "failing every attempt" and "not being invoked at all".
 *
 * Only agents with a run() path that writes to agent_run_logs. Skips an
 * agent entirely (no query issued) when its own config flag is off --
 * both scannerAgentEnabled/chartAnalysisAgentEnabled default false, and
 * an intentionally-disabled agent must never page as "unhealthy".
 */
const WATCHED_AGENTS: WatchedAgent[] = [
  { name: "scanner", isEnabled: () => config.scannerAgentEnabled },
  { name: "chart-analysis", isEnabled: () => config.chartAnalysisAgentEnabled },
];

export const agentHealthWatchdogJob: JobDefinition = {
  name: "agent-health-watchdog",
  intervalSeconds: 300,
  timeoutMs: 15_000,
  async run(ctx) {
    for (const agent of WATCHED_AGENTS) {
      if (!agent.isEnabled()) continue;

      const { rows } = await ctx.pool.query<{ created_at: Date }>(
        `SELECT created_at FROM agent_run_logs
         WHERE agent_name = $1 AND status = 'success'
         ORDER BY created_at DESC LIMIT 1`,
        [agent.name],
      );

      const lastSuccessAt = rows[0]?.created_at ?? null;
      const sinceMs = lastSuccessAt ? Date.now() - new Date(lastSuccessAt).getTime() : null;

      if (sinceMs === null || sinceMs > UNHEALTHY_THRESHOLD_MS) {
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
