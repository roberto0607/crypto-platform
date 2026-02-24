import type { FastifyPluginAsync } from "fastify";
import { config } from "../config";
import { pool } from "../db/pool";

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
