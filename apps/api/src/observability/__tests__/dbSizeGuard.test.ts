import { describe, it, expect, vi, afterEach } from "vitest";
import type { Pool } from "pg";
import type { Logger } from "pino";
import { pool } from "../../db/pool";
import {
  classifyDbSize,
  checkDbSize,
  measureDbSize,
  nonEssentialWritesPaused,
  setDbSizeLevelForTest,
  startDbSizeGuard,
  stopDbSizeGuard,
  currentDbSizeLevel,
} from "../dbSizeGuard";
import { runLogPolicy } from "../../agents/shared/runLogPolicy";

const MB = 1024 * 1024;
const T = { limitBytes: 1000 * MB, warnPct: 70, criticalPct: 85 };

function fakePool(sizes: { db: number; wal?: number | "denied" }[]): Pool {
  let i = 0;
  let current = sizes[0]!;
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("pg_database_size")) {
        current = sizes[Math.min(i++, sizes.length - 1)]!;
        return { rows: [{ bytes: String(current.db) }] };
      }
      if (sql.includes("pg_ls_waldir")) {
        if (current.wal === "denied") throw new Error("permission denied for function pg_ls_waldir");
        return { rows: [{ bytes: String(current.wal ?? 0) }] };
      }
      throw new Error(`unexpected sql ${sql}`);
    }),
  } as unknown as Pool;
}

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger & {
    info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>;
  };
}

afterEach(() => {
  stopDbSizeGuard();
  setDbSizeLevelForTest("unknown");
  runLogPolicy.reset();
  vi.useRealTimers();
});

describe("classifyDbSize", () => {
  it("is always ok without a configured limit", () => {
    expect(classifyDbSize(10 ** 15, { ...T, limitBytes: 0 })).toBe("ok");
  });

  it("applies the 70% / 85% thresholds", () => {
    expect(classifyDbSize(699 * MB, T)).toBe("ok");
    expect(classifyDbSize(700 * MB, T)).toBe("warn");
    expect(classifyDbSize(849 * MB, T)).toBe("warn");
    expect(classifyDbSize(850 * MB, T)).toBe("critical");
  });
});

describe("checkDbSize", () => {
  it("logs info below warn and counts WAL toward the total", async () => {
    const log = fakeLogger();
    const r = await checkDbSize(fakePool([{ db: 400 * MB, wal: 200 * MB }]), log, T);
    expect(r.totalBytes).toBe(600 * MB);
    expect(r.level).toBe("ok");
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ eventType: "db_size", totalMb: 600 }), "db_size");
    expect(nonEssentialWritesPaused()).toBe(false);
  });

  it("falls back to database size alone when pg_ls_waldir is not permitted", async () => {
    const r = await checkDbSize(fakePool([{ db: 100 * MB, wal: "denied" }]), fakeLogger(), T);
    expect(r.walBytes).toBeNull();
    expect(r.totalBytes).toBe(100 * MB);
  });

  it("warns at 70%, pauses non-essential writes at 85%, resumes below", async () => {
    const log = fakeLogger();
    const p = fakePool([{ db: 750 * MB }, { db: 900 * MB }, { db: 600 * MB }]);

    await checkDbSize(p, log, T);
    expect(currentDbSizeLevel()).toBe("warn");
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ level: "warn" }), expect.stringContaining("db_size_warning"));
    expect(nonEssentialWritesPaused()).toBe(false);

    await checkDbSize(p, log, T);
    expect(nonEssentialWritesPaused()).toBe(true);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ level: "critical", nonEssentialWritesPaused: true }),
      expect.stringContaining("DB_SIZE_CRITICAL"),
    );

    await checkDbSize(p, log, T);
    expect(nonEssentialWritesPaused()).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ nonEssentialWritesPaused: false }),
      "db_size_recovered: non-essential writes resumed",
    );
  });
});

describe("pause effect", () => {
  it("agent run logs (even errors) are not persisted while critical", () => {
    setDbSizeLevelForTest("critical");
    expect(runLogPolicy.shouldPersist({ agentName: "x", status: "error", ledToAction: false })).toBe(false);
    expect(runLogPolicy.shouldPersist({ agentName: "x", status: "success", ledToAction: true })).toBe(false);
    setDbSizeLevelForTest("warn");
    expect(runLogPolicy.shouldPersist({ agentName: "x", status: "error", ledToAction: false })).toBe(true);
  });
});

describe("startDbSizeGuard", () => {
  it("checks immediately, then hourly; every 5 min while elevated", async () => {
    vi.useFakeTimers();
    const p = fakePool([{ db: 100 * MB }, { db: 100 * MB }, { db: 800 * MB }, { db: 800 * MB }]);
    const log = fakeLogger();
    startDbSizeGuard({ pool: p, logger: log, thresholds: T, intervalMs: 3_600_000, elevatedIntervalMs: 300_000 });

    await vi.advanceTimersByTimeAsync(0);
    expect(log.info).toHaveBeenCalledTimes(1); // boot check

    await vi.advanceTimersByTimeAsync(300_000);
    expect(log.info).toHaveBeenCalledTimes(1); // ok → not yet (hourly)

    await vi.advanceTimersByTimeAsync(3_300_000);
    expect(log.info).toHaveBeenCalledTimes(2); // 1h

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(log.warn).toHaveBeenCalledTimes(1); // 2h → 80% → warn

    await vi.advanceTimersByTimeAsync(300_000);
    expect(log.warn).toHaveBeenCalledTimes(2); // elevated cadence: 5 min later
  });

  it("warns once at start when no limit is configured", async () => {
    vi.useFakeTimers();
    const log = fakeLogger();
    startDbSizeGuard({
      pool: fakePool([{ db: MB }]), logger: log, thresholds: { ...T, limitBytes: 0 },
      intervalMs: 3_600_000, elevatedIntervalMs: 300_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("DB_SIZE_LIMIT_MB is not set"));
  });
});

describe("measureDbSize (real Postgres)", () => {
  it("returns a positive database size", async () => {
    const r = await measureDbSize(pool);
    expect(r.dbBytes).toBeGreaterThan(0);
  });
});
