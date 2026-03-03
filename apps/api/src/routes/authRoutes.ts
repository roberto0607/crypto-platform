import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";

import { config } from "../config";
import { pool } from "../db/pool";
import { normalizeEmail } from "../auth/normalizeEmail";
import { hashPassword, verifyPassword } from "../auth/password";
import { createUser, findUserByEmailNormalized } from "../auth/userRepo";
import { auditLog } from "../audit/log";
import { requireUser } from "../auth/requireUser";
import { newRefreshToken, storeRefreshToken } from "../auth/refreshTokens";
import { findValidRefreshTokenByHash, revokeRefreshTokenById } from "../auth/refreshRepo";
import { REFRESH_COOKIE_NAME, refreshCookieSetOptions, refreshCookieClearOptions } from "../auth/cookieOptions";
import { AppError } from "../errors/AppError";
import { handleError } from "../http/handleError";
import { validateInvite, consumeInviteTx } from "../beta/inviteRepo";
import { inviteConsumedTotal } from "../metrics";

// ── Zod schemas ──
const registerBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(72),
  inviteCode: z.string().optional(),
});

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(72),
});

// ── Plugin (registered with prefix "/auth") ──
const authRoutes: FastifyPluginAsync = async (app) => {

  // POST /auth/register — rate limit: 3/min per IP
  app.post("/register", { config: { rateLimit: { max: 3, timeWindow: 60_000 } } }, async (req, reply) => {
    const parsed = registerBody.safeParse(req.body);

    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_input",
        details: parsed.error.flatten(),
      });
    }

    // ── Beta invite gate ──
    if (config.betaMode) {
      if (!parsed.data.inviteCode) {
        return handleError(reply, new AppError("invite_required"));
      }

      const invite = await validateInvite(parsed.data.inviteCode);
      if (!invite) {
        return handleError(reply, new AppError("invite_invalid"));
      }

      // Atomic: create user + consume invite in one transaction
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const { email, emailNormalized } = normalizeEmail(parsed.data.email);
        const passwordHash = await hashPassword(parsed.data.password);

        const userResult = await client.query<{ id: string; email: string; role: string }>(
          `INSERT INTO users (email, email_normalized, password_hash)
           VALUES ($1, $2, $3)
           RETURNING id, email, role`,
          [email, emailNormalized, passwordHash],
        );
        const user = userResult.rows[0];

        await consumeInviteTx(client, invite.id);
        await client.query("COMMIT");

        inviteConsumedTotal.inc();

        await auditLog({
          actorUserId: user.id,
          action: "auth.register",
          targetType: "user",
          targetId: user.id,
          requestId: req.id,
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          metadata: { emailNormalized, inviteCode: parsed.data.inviteCode },
        });

        return reply.code(201).send({
          ok: true,
          user: { id: user.id, email: user.email, role: user.role },
        });
      } catch (err: any) {
        await client.query("ROLLBACK").catch(() => {});
        if (err?.code === "23505") return handleError(reply, new AppError("email_taken"));
        if (err?.message === "invite_invalid") return handleError(reply, new AppError("invite_invalid"));
        req.log.error({ err }, "register_failed");
        return handleError(reply, new AppError("server_error"));
      } finally {
        client.release();
      }
    }

    // ── Open registration (BETA_MODE=false) ──
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
      if (err?.code === "23505") return handleError(reply, new AppError("email_taken"));
      req.log.error({ err }, "register_failed");
      return handleError(reply, new AppError("server_error"));
    }
  });

  // POST /auth/login — rate limit: 5/min per IP
  app.post("/login", { config: { rateLimit: { max: 5, timeWindow: 60_000 } } }, async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);

    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_input",
        details: parsed.error.flatten(),
      });
    }

    const { emailNormalized } = normalizeEmail(parsed.data.email);

    const user = await findUserByEmailNormalized(emailNormalized);

    if (!user) {
      return reply.code(401).send({ ok: false, error: "invalid_credentials" });
    }

    const ok = await verifyPassword(parsed.data.password, user.password_hash);
    if (!ok) {
      return reply.code(401).send({ ok: false, error: "invalid_credentials" });
    }

    // Issue access token
    const accessToken = app.jwt.sign(
      { sub: user.id, role: user.role },
      { expiresIn: config.jwtAccessTtlSeconds }
    );

    // Issue refresh token (HttpOnly cookie) + store hash in DB
    const { token: refreshToken, tokenHash } = newRefreshToken();
    const refreshExpiresAt = new Date(
      Date.now() + config.jwtRefreshTtlSeconds * 1000
    );

    await storeRefreshToken({
      userId: user.id,
      tokenHash,
      expiresAt: refreshExpiresAt,
    });

    reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieSetOptions(refreshExpiresAt));

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

  // POST /auth/refresh
  app.post("/refresh", async (req, reply) => {
    const rawToken = (req.cookies as any)?.[REFRESH_COOKIE_NAME] as string | undefined;

    if (!rawToken) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }

    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    const row = await findValidRefreshTokenByHash(tokenHash);
    if (!row) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }

    // Rotate: revoke old refresh token row
    await revokeRefreshTokenById(row.id);

    // Mint new refresh token + store new hash
    const { token: newToken, tokenHash: newHash } = newRefreshToken();
    const refreshExpiresAt = new Date(
      Date.now() + config.jwtRefreshTtlSeconds * 1000
    );

    await storeRefreshToken({
      userId: row.user_id,
      tokenHash: newHash,
      expiresAt: refreshExpiresAt,
    });

    // Set new cookie
    reply.setCookie(REFRESH_COOKIE_NAME, newToken, refreshCookieSetOptions(refreshExpiresAt));

    // Issue new access token (lookup role from users)
    const userRes = await pool.query<{ role: string }>(
      `SELECT role FROM users WHERE id = $1 LIMIT 1`,
      [row.user_id]
    );
    const role = userRes.rows[0]?.role ?? "USER";

    const accessToken = app.jwt.sign(
      { sub: row.user_id, role },
      { expiresIn: config.jwtAccessTtlSeconds }
    );

    return reply.code(200).send({ ok: true, accessToken });
  });

  // GET /auth/me
  app.get("/me", { preHandler: requireUser }, async (req, reply) => {
    const user = req.user!;

    return reply.send({
      ok: true,
      user: { id: user.id, role: user.role },
    });
  });

  // POST /auth/logout
  app.post("/logout", async (req, reply) => {
    const rawToken = (req.cookies as any)?.[REFRESH_COOKIE_NAME] as string | undefined;

    let actorUserId: string | null = null;

    if (rawToken) {
      const tokenHash = createHash("sha256").update(rawToken).digest("hex");
      const row = await findValidRefreshTokenByHash(tokenHash);
      if (row) {
        actorUserId = row.user_id;
        await revokeRefreshTokenById(row.id);
      }
    }

    reply.clearCookie(REFRESH_COOKIE_NAME, refreshCookieClearOptions);

    await auditLog({
      actorUserId,
      action: "auth.logout",
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
    });

    return reply.code(200).send({ ok: true });
  });
};

export default authRoutes;
