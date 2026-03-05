import type { FastifyPluginAsync } from "fastify";
import { config } from "../config";
import { pool } from "../db/pool";
import { getStats } from "../events/eventBus";
import { getLeadershipStatus } from "../coordination/leaderElection";
import { getRedis } from "../db/redis";

type CheckStatus = "OK" | "DEGRADED" | "CRITICAL" | "WARNING" | "UNKNOWN";

interface DeepHealthResult {
  status: "OK" | "DEGRADED" | "CRITICAL";
  checks: {
    database: { status: CheckStatus; latencyMs: number };
    redis: { status: CheckStatus; enabled: boolean };
    eventBus: { status: CheckStatus; subscriberCount: number; globalCount: number };
    breakers: { status: CheckStatus; openCount: number };
    reconciliation: { status: CheckStatus };
  };
}

const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => {
    return { ok: true, service: "api", timestamp: new Date().toISOString() };
  });

  app.get("/health/db", async () => {
    const res = await pool.query("select 1 as ok");
    return { ok: res.rows[0]?.ok === 1 };
  });

  app.get("/health/pool", async () => {
    return {
      ok: true,
      pool: {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
      },
    };
  });

  app.get("/health/deep", async () => {
    const result: DeepHealthResult = {
      status: "OK",
      checks: {
        database: { status: "OK", latencyMs: 0 },
        redis: { status: "OK", enabled: false },
        eventBus: { status: "OK", subscriberCount: 0, globalCount: 0 },
        breakers: { status: "OK", openCount: 0 },
        reconciliation: { status: "UNKNOWN" },
      },
    };

    // 1. Database connectivity
    try {
      const start = process.hrtime();
      await pool.query("SELECT 1");
      const diff = process.hrtime(start);
      result.checks.database.latencyMs = Math.round((diff[0] * 1e3) + (diff[1] / 1e6));
      result.checks.database.status = "OK";
    } catch {
      result.checks.database.status = "CRITICAL";
    }

    // 2. Redis connectivity
    const redis = getRedis();
    if (redis) {
      result.checks.redis.enabled = true;
      try {
        await redis.ping();
        result.checks.redis.status = "OK";
      } catch {
        result.checks.redis.status = "DEGRADED";
      }
    }

    // 3. Event bus subscriber count
    try {
      const stats = getStats();
      result.checks.eventBus.subscriberCount = stats.handlerCount;
      result.checks.eventBus.globalCount = stats.globalCount;
      result.checks.eventBus.status = "OK";
    } catch {
      result.checks.eventBus.status = "DEGRADED";
    }

    // 4. Breaker state summary
    try {
      const { rows } = await pool.query<{ open_count: string }>(
        `SELECT COUNT(*)::text AS open_count
           FROM circuit_breakers
          WHERE status = 'OPEN'
            AND (closes_at IS NULL OR closes_at > now())`
      );
      const openCount = parseInt(rows[0].open_count, 10);
      result.checks.breakers.openCount = openCount;
      result.checks.breakers.status = openCount > 0 ? "DEGRADED" : "OK";
    } catch {
      result.checks.breakers.status = "CRITICAL";
    }

    // 5. Reconciliation last run status (from audit_log)
    try {
      const { rows } = await pool.query<{ metadata: { overallStatus?: string } }>(
        `SELECT metadata
           FROM audit_log
          WHERE action = 'reconciliation.run'
          ORDER BY created_at DESC
          LIMIT 1`
      );
      if (rows.length > 0 && rows[0].metadata?.overallStatus) {
        result.checks.reconciliation.status = rows[0].metadata.overallStatus as CheckStatus;
      } else {
        result.checks.reconciliation.status = "UNKNOWN";
      }
    } catch {
      result.checks.reconciliation.status = "UNKNOWN";
    }

    // Derive overall status
    if (result.checks.database.status === "CRITICAL") {
      result.status = "CRITICAL";
    } else if (
      result.checks.breakers.status === "DEGRADED" ||
      result.checks.database.status !== "OK"
    ) {
      result.status = "DEGRADED";
    } else if (
      result.checks.reconciliation.status === "CRITICAL"
    ) {
      result.status = "CRITICAL";
    } else if (
      result.checks.reconciliation.status === "WARNING" ||
      result.checks.eventBus.status === "DEGRADED" ||
      result.checks.redis.status === "DEGRADED"
    ) {
      result.status = "DEGRADED";
    }

    return result;
  });

  // ── Phase 10 PR5: Instance identity + leader status ──
  const startedAt = new Date().toISOString();

  app.get("/health/instance", async () => {
    return {
      instanceId: config.instanceId,
      role: config.instanceRole,
      leader: getLeadershipStatus(),
      startedAt,
      version: "1.0.0",
    };
  });

  if (!config.isProd) {
    app.get("/dev/jwt-test", async () => {
      const token = app.jwt.sign(
        { sub: "dev-user-id", role: "USER" },
        { expiresIn: config.jwtAccessTtlSeconds }
      );
      return { token };
    });
  }
};

export default healthRoutes;
