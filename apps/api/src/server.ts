/**
 * server.ts — Fastify API Entry Point
 *
 * Boots the HTTP server, registers health-check routes, and binds to the
 * configured host/port. This is the main process for the API service.
 *
 * Startup order:
 *   1. dotenv/config loads .env into process.env
 *   2. pool.ts is imported → PG connection pool reads DATABASE_URL
 *   3. Fastify instance is created with structured (pino) logging
 *   4. Routes are registered
 *   5. Server listens; on failure, logs and exits with code 1
 */

import Fastify from "fastify";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import { z } from "zod";

import { config } from "./config";
import { pool } from "./db/pool";

import { normalizeEmail } from "./auth/normalizeEmail";
import { hashPassword, verifyPassword } from "./auth/password";
import { createUser, findUserByEmailNormalized } from "./auth/userRepo";
import { auditLog } from "./audit/log";
import { requireUser } from "./auth/requireUser";

async function start() {
  const app = Fastify({ logger: true });

  await app.register(cookie);

  await app.register(jwt, {
    secret: config.jwtAccessSecret,
  });

  app.get("/health", async () => {
    return { ok: true, service: "api", timestamp: new Date().toISOString() };
  });

  app.get("/health/db", async () => {
    const res = await pool.query("select 1 as ok");
    return { ok: res.rows[0]?.ok === 1 };
  });

  app.get("/dev/jwt-test", async () => {
    const token = app.jwt.sign(
      { sub: "dev-user-id", role: "USER" },
      { expiresIn: config.jwtAccessTtlSeconds }
    );
    return { token };
  });

  // -------- Phase 1.2: Register --------
  const registerBody = z.object({
    email: z.string().email(),
    password: z.string().min(8).max(72),
  });

  app.post("/auth/register", async (req, reply) => {
    const parsed = registerBody.safeParse(req.body);

    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_input",
        details: parsed.error.flatten(),
      });
    }

    const { email, emailNormalized } = normalizeEmail(parsed.data.email);
    const passwordHash = await hashPassword(parsed.data.password);

    try {
      const user = await createUser({ email, emailNormalized, passwordHash });

      await auditLog({
        actorUserId: user.id,
        action: "auth.register",
        targetType: "user",
        targetId: user.id,
        requestId: req.id,
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        metadata: { emailNormalized },
      });

      return reply.code(201).send({
        ok: true,
        user: { id: user.id, email: user.email, role: user.role },
      });
    } catch (err: any) {
      if (err?.code === "23505") {
        return reply.code(409).send({ ok: false, error: "email_taken" });
      }
      req.log.error({ err }, "register_failed");
      return reply.code(500).send({ ok: false, error: "server_error" });
    }
  });
  // -------------------------------------

  // -------- Phase 1.2: Login (access JWT) --------
  const loginBody = z.object({
    email: z.string().email(),
    password: z.string().min(8).max(72),
  });

  app.post("/auth/login", async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);

    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_input",
        details: parsed.error.flatten(),
      });
    }

    const { emailNormalized } = normalizeEmail(parsed.data.email);

    // find user
    const user = await findUserByEmailNormalized(emailNormalized);

    // Do NOT reveal whether email exists (prevents account enumeration)
    if (!user) {
      return reply.code(401).send({ ok: false, error: "invalid_credentials" });
    }

    // verify password
    const ok = await verifyPassword(parsed.data.password, user.password_hash);
    if (!ok) {
      return reply.code(401).send({ ok: false, error: "invalid_credentials" });
    }

    // issue access token
    const accessToken = app.jwt.sign(
      { sub: user.id, role: user.role },
      { expiresIn: config.jwtAccessTtlSeconds }
    );

    await auditLog({
      actorUserId: user.id,
      action: "auth.login",
      targetType: "user",
      targetId: user.id,
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
      metadata: { emailNormalized },
    });

    return reply.code(200).send({
      ok: true,
      accessToken,
      user: { id: user.id, email: user.email, role: user.role },
    });
  });
  // ----------------------------------------------

  // -------- Phase 1.3: requireUser --------
  app.get("/auth/me", { preHandler: requireUser }, async (req, reply) => {
    const user = (req as any).user as { id: string, role: string };

    return reply.send({
        ok : true,
        user: { id: user.id, role: user.role},
    });
  });

  const port = config.port;
  const host = config.host;

  await app.listen({ port, host });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
