/**
 * Test helpers — shared utilities for integration tests.
 *
 * Provides buildTestApp() which creates a Fastify instance wired to the
 * real database (docker-compose Postgres on port 5433).
 */

import { buildApp } from "../src/app";
import { pool } from "../src/db/pool";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance | null = null;

/** Get or create a shared Fastify app instance for tests. */
export async function getTestApp(): Promise<FastifyInstance> {
  if (!app) {
    app = await buildApp({ disableRateLimit: true, logger: false, disableKrakenFeed: true });
    await app.ready();

    // Widen global risk limits so integration tests aren't blocked
    await pool.query(`
      UPDATE risk_limits
      SET max_price_deviation_bps = 99999,
          max_order_notional_quote = '999999999.00000000',
          max_position_base_qty   = '999999999.00000000',
          max_open_orders_per_pair = 9999
      WHERE user_id IS NULL AND pair_id IS NULL
    `);
  }
  return app;
}

/** Close the shared app (call in globalTeardown or afterAll of last suite). */
export async function closeTestApp(): Promise<void> {
  if (app) {
    await app.close();
    app = null;
  }
}

/** Get the raw pg pool for direct DB setup/teardown in tests. */
export function getPool() {
  return pool;
}

/**
 * Register a test user and return their access token + user info.
 * Generates a unique email to avoid collisions.
 */
export async function registerAndLogin(appInstance: FastifyInstance, emailPrefix = "test") {
  const email = `${emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;
  const password = "TestPass1234";

  // Register
  await appInstance.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password },
  });

  // Login
  const loginRes = await appInstance.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password },
  });

  const loginBody = loginRes.json();
  const cookies = loginRes.cookies as Array<{ name: string; value: string }>;
  const refreshCookie = cookies.find((c) => c.name === "refresh_token");

  return {
    email,
    password,
    accessToken: loginBody.accessToken as string,
    userId: loginBody.user.id as string,
    refreshCookieValue: refreshCookie?.value ?? "",
  };
}
