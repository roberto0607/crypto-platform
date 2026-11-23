import type { JobDefinition } from "../jobTypes";
import { config } from "../../config.js";
import { runFeatureRecorder } from "../../agents/confluence/live/featureRecorder.js";

/**
 * Confluence feature recorder (Phase 1): one setup_features row per closed
 * BTC 4h bar, written at close + 5 minutes. Records data only: no orders,
 * no LLM. Registered unconditionally; the gate is FEATURE_RECORDER_ENABLED
 * (default off, ANDed with AGENTS_ENABLED), checked in run(). Polls every
 * 5 minutes and is a no-op until a close is due. The DB-size guardrail
 * pause is checked inside the recorder.
 *
 * The first run in a fresh database syncs Coinbase 1h/1d history from
 * 2015 and a year of Deribit funding, hence the long timeout.
 */
export const featureRecorderJob: JobDefinition = {
  name: "feature-recorder",
  intervalSeconds: 300,
  timeoutMs: 15 * 60_000,
  maxRunSeconds: 20 * 60,
  async run(ctx) {
    if (!config.featureRecorderEnabled) return;
    const s = await runFeatureRecorder({ log: (msg) => ctx.logger.info(msg) });
    if (s.status === "paused") {
      ctx.logger.warn({ eventType: "db_size" }, "feature_recorder_skipped_db_size_critical");
      return;
    }
    if (s.sourceErrors.length > 0) ctx.logger.warn({ sourceErrors: s.sourceErrors }, "feature_recorder_source_errors");
    if (s.status === "recorded") {
      ctx.logger.info(
        { rows: s.rows.length, late: s.rows.filter((r) => r.late).length, barTimes: s.rows.map((r) => r.barTime) },
        "feature_recorder_recorded",
      );
    }
  },
};
