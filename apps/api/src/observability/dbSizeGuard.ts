/**
 * dbSizeGuard.ts — disk-pressure guardrail for Postgres.
 *
 * The prod Postgres crashed when its volume filled. This logs the database
 * size every hour (DB_SIZE_CHECK_INTERVAL_MS), and against DB_SIZE_LIMIT_MB:
 *
 *   < warn% (70)      ok        — info log
 *   ≥ warn%           warn      — warn log
 *   ≥ critical% (85)  critical  — error log, non-essential writes PAUSED
 *
 * Non-essential = agent cycles (scanner, chart analysis, news), agent run
 * logs, footprint candles. Trading, auth, audit, candles for the allowlisted
 * pairs and retention keep running — retention is what brings the size back
 * down. Once below critical the pause lifts on the next check. While above
 * ok it re-checks every DB_SIZE_ELEVATED_INTERVAL_MS (5 min) so a pause
 * engages / lifts promptly.
 *
 * Size = pg_database_size + pg_wal (best-effort: pg_ls_waldir needs
 * superuser or pg_monitor; when denied, WAL is reported as null and only
 * the database size counts). Runs per process — every API instance keeps its
 * own pause flag current — and is started from server.ts only.
 */
import type { Pool } from "pg";
import type { Logger } from "pino";
import { dbSizeBytesGauge, dbSizeNonEssentialPausedGauge } from "../metrics";
import { currentDbSizeLevel, setDbSizeLevel, type DbSizeLevel } from "./writePause";

export { nonEssentialWritesPaused, currentDbSizeLevel, type DbSizeLevel } from "./writePause";

export interface DbSizeThresholds {
  limitBytes: number; // 0 = no limit configured → always "ok"
  warnPct: number;
  criticalPct: number;
}

export interface DbSizeReading {
  dbBytes: number;
  walBytes: number | null;
  totalBytes: number;
  limitBytes: number;
  pctOfLimit: number | null;
  level: DbSizeLevel;
}

export function classifyDbSize(totalBytes: number, t: DbSizeThresholds): DbSizeLevel {
  if (!(t.limitBytes > 0)) return "ok";
  const pct = (totalBytes / t.limitBytes) * 100;
  if (pct >= t.criticalPct) return "critical";
  if (pct >= t.warnPct) return "warn";
  return "ok";
}

/** Test hook. */
export function setDbSizeLevelForTest(l: DbSizeLevel): void {
  setDbSizeLevel(l);
}

export async function measureDbSize(pool: Pool): Promise<{ dbBytes: number; walBytes: number | null }> {
  const { rows } = await pool.query<{ bytes: string }>(
    `SELECT pg_database_size(current_database())::text AS bytes`,
  );
  const dbBytes = Number(rows[0]!.bytes);
  let walBytes: number | null = null;
  try {
    const { rows: w } = await pool.query<{ bytes: string | null }>(
      `SELECT coalesce(sum(size), 0)::text AS bytes FROM pg_ls_waldir()`,
    );
    walBytes = Number(w[0]!.bytes ?? 0);
  } catch {
    walBytes = null; // no permission — database size alone
  }
  return { dbBytes, walBytes };
}

const MB = 1024 * 1024;

export async function checkDbSize(pool: Pool, logger: Logger, t: DbSizeThresholds): Promise<DbSizeReading> {
  const { dbBytes, walBytes } = await measureDbSize(pool);
  const totalBytes = dbBytes + (walBytes ?? 0);
  const next = classifyDbSize(totalBytes, t);
  const pctOfLimit = t.limitBytes > 0 ? Math.round((totalBytes / t.limitBytes) * 1000) / 10 : null;
  const reading: DbSizeReading = { dbBytes, walBytes, totalBytes, limitBytes: t.limitBytes, pctOfLimit, level: next };

  const prev = currentDbSizeLevel();
  setDbSizeLevel(next);
  dbSizeBytesGauge.set({ kind: "database" }, dbBytes);
  if (walBytes !== null) dbSizeBytesGauge.set({ kind: "wal" }, walBytes);
  dbSizeNonEssentialPausedGauge.set(next === "critical" ? 1 : 0);

  const fields = {
    eventType: "db_size",
    dbMb: Math.round(dbBytes / MB),
    walMb: walBytes === null ? null : Math.round(walBytes / MB),
    totalMb: Math.round(totalBytes / MB),
    limitMb: t.limitBytes > 0 ? Math.round(t.limitBytes / MB) : null,
    pctOfLimit,
    level: next,
  };

  if (next === "critical") {
    logger.error(
      { ...fields, nonEssentialWritesPaused: true },
      `DB_SIZE_CRITICAL: database at ${pctOfLimit}% of DB_SIZE_LIMIT_MB (>= ${t.criticalPct}%) — ` +
        `non-essential writes (agents, agent logs, footprint) are PAUSED until it drops below ${t.criticalPct}%`,
    );
  } else if (next === "warn") {
    logger.warn(fields, `db_size_warning: database at ${pctOfLimit}% of DB_SIZE_LIMIT_MB (>= ${t.warnPct}%)`);
  } else {
    logger.info(fields, "db_size");
  }
  if (prev === "critical" && next !== "critical") {
    logger.warn({ ...fields, nonEssentialWritesPaused: false }, "db_size_recovered: non-essential writes resumed");
  }
  return reading;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

export function startDbSizeGuard(opts: {
  pool: Pool;
  logger: Logger;
  thresholds: DbSizeThresholds;
  intervalMs: number;
  elevatedIntervalMs: number;
}): void {
  if (!stopped) return;
  stopped = false;
  if (!(opts.thresholds.limitBytes > 0)) {
    opts.logger.warn(
      { eventType: "db_size" },
      "DB_SIZE_LIMIT_MB is not set — db size is logged hourly but the 70%/85% guardrail is inactive",
    );
  }
  const tick = async () => {
    try {
      await checkDbSize(opts.pool, opts.logger, opts.thresholds);
    } catch (err) {
      opts.logger.error({ err, eventType: "db_size" }, "db_size_check_failed");
    }
    if (stopped) return;
    const l = currentDbSizeLevel();
    const delay = l === "warn" || l === "critical" ? opts.elevatedIntervalMs : opts.intervalMs;
    timer = setTimeout(tick, delay);
    timer.unref?.();
  };
  void tick();
}

export function stopDbSizeGuard(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}
