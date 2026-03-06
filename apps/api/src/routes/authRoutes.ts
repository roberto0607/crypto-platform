import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";

import { config } from "../config";
import { pool } from "../db/pool";
import { normalizeEmail } from "../auth/normalizeEmail";
import { hashPassword, verifyPassword } from "../auth/password";
import { createUser, findUserByEmailNormalized, findUserById } from "../auth/userRepo";
import { auditLog } from "../audit/log";
import { requireUser } from "../auth/requireUser";
import { newRefreshToken, storeRefreshToken } from "../auth/refreshTokens";
import { findRefreshTokenByHash, revokeRefreshTokenById, revokeTokenFamily, markReplacedBy } from "../auth/refreshRepo";
import { REFRESH_COOKIE_NAME, refreshCookieSetOptions, refreshCookieClearOptions } from "../auth/cookieOptions";
import { AppError } from "../errors/AppError";
import { handleError } from "../http/handleError";
import { validateInvite, consumeInviteTx } from "../beta/inviteRepo";
import { inviteConsumedTotal, refreshTokenReuseDetectedTotal, refreshTokenFamilyRevokedTotal, emailsSentTotal, emailVerificationsTotal, passwordResetsTotal } from "../metrics";
import { isLoginBlocked, recordLoginAttempt } from "../security/loginProtectionService";
import { createEmailToken, consumeEmailToken } from "../email/emailTokenRepo";
import { sendEmail } from "../email/emailTransport";
import { verificationEmail, passwordResetEmail } from "../email/templates";
import { logger } from "../observability/logContext";

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

        // Fire-and-forget verification email
        const rawToken = await createEmailToken(user.id, "EMAIL_VERIFY", 1440);
        const { subject, html } = verificationEmail(rawToken);
        sendEmail(user.email, subject, html)
          .then(() => emailsSentTotal.inc({ kind: "verification" }))
          .catch((err) => logger.error({ err, userId: user.id }, "Failed to send verification email"));

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

      // Fire-and-forget verification email
      const rawToken = await createEmailToken(user.id, "EMAIL_VERIFY", 1440);
      const { subject, html } = verificationEmail(rawToken);
      sendEmail(user.email, subject, html)
        .then(() => emailsSentTotal.inc({ kind: "verification" }))
        .catch((err) => logger.error({ err, userId: user.id }, "Failed to send verification email"));

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

    // ── Login abuse protection: check before attempting ──
    const blocked = await isLoginBlocked({ emailNormalized, ipAddress: req.ip });
    if (blocked) {
      return reply.code(429).send({
        error: { code: "LOGIN_BLOCKED", message: "Too many failed login attempts." },
      });
    }

    const user = await findUserByEmailNormalized(emailNormalized);

    if (!user) {
      await recordLoginAttempt({ emailNormalized, ipAddress: req.ip, success: false });
      return reply.code(401).send({ ok: false, error: "invalid_credentials" });
    }

    const ok = await verifyPassword(parsed.data.password, user.password_hash);
    if (!ok) {
      await recordLoginAttempt({ emailNormalized, ipAddress: req.ip, success: false });
      return reply.code(401).send({ ok: false, error: "invalid_credentials" });
    }

    // Record successful login (resets effective window)
    await recordLoginAttempt({ emailNormalized, ipAddress: req.ip, success: true });

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

    const stored = await storeRefreshToken({
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
      metadata: { emailNormalized, familyId: stored.familyId },
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

    const row = await findRefreshTokenByHash(tokenHash);

    // Token not found or expired
    if (!row) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }

    // ── Reuse detection: token was already revoked ──
    if (row.revoked_at) {
      // Someone already used this token and got a new one.
      // This replay means either theft or a confused client.
      // Nuclear option: revoke the entire family.
      const revokedCount = await revokeTokenFamily(row.family_id);
      refreshTokenReuseDetectedTotal.inc();
      refreshTokenFamilyRevokedTotal.inc();

      await auditLog({
        actorUserId: row.user_id,
        action: "auth.refresh_reuse_detected",
        targetType: "refresh_token",
        targetId: row.id,
        requestId: req.id,
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        metadata: { familyId: row.family_id, revokedCount },
      });

      reply.clearCookie(REFRESH_COOKIE_NAME, refreshCookieClearOptions);
      return reply.code(401).send({ ok: false, error: "refresh_token_reuse" });
    }

    // ── Valid token: rotate ──
    await revokeRefreshTokenById(row.id);

    // Mint new refresh token inheriting the same family
    const { token: newToken, tokenHash: newHash } = newRefreshToken();
    const refreshExpiresAt = new Date(
      Date.now() + config.jwtRefreshTtlSeconds * 1000
    );

    const stored = await storeRefreshToken({
      userId: row.user_id,
      tokenHash: newHash,
      expiresAt: refreshExpiresAt,
      familyId: row.family_id,
    });

    // Record chain: old token → new token
    await markReplacedBy(row.id, stored.id);

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

    const { rows } = await pool.query<{ email: string; email_verified_at: string | null }>(
      "SELECT email, email_verified_at FROM users WHERE id = $1",
      [user.id]
    );

    return reply.send({
      ok: true,
      user: {
        id: user.id,
        email: rows[0]?.email,
        role: user.role,
        emailVerified: !!rows[0]?.email_verified_at,
      },
    });
  });

  // POST /auth/logout
  app.post("/logout", async (req, reply) => {
    const rawToken = (req.cookies as any)?.[REFRESH_COOKIE_NAME] as string | undefined;

    let actorUserId: string | null = null;

    if (rawToken) {
      const tokenHash = createHash("sha256").update(rawToken).digest("hex");
      const row = await findRefreshTokenByHash(tokenHash);
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

  // POST /auth/verify-email
  const verifyEmailBody = z.object({
    token: z.string().min(1),
  });

  app.post("/verify-email", async (req, reply) => {
    const parsed = verifyEmailBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_input" });
    }

    const result = await consumeEmailToken(parsed.data.token, "EMAIL_VERIFY");
    if (!result) {
      return reply.code(400).send({ ok: false, error: "invalid_or_expired_token" });
    }

    await pool.query(
      "UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL",
      [result.userId]
    );

    emailVerificationsTotal.inc();

    await auditLog({
      actorUserId: result.userId,
      action: "auth.email_verified",
      targetType: "user",
      targetId: result.userId,
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
    });

    return reply.send({ ok: true });
  });

  // POST /auth/resend-verification (rate limited, authenticated)
  app.post("/resend-verification", {
    config: { rateLimit: { max: 3, timeWindow: "15 minutes" } },
    preHandler: [requireUser],
  }, async (req, reply) => {
    const user = await findUserById(req.user!.id);
    if (!user) return reply.code(404).send({ ok: false, error: "user_not_found" });

    // Check if already verified
    const { rows } = await pool.query<{ email_verified_at: string | null }>(
      "SELECT email_verified_at FROM users WHERE id = $1",
      [user.id]
    );
    if (rows[0]?.email_verified_at) return reply.send({ ok: true, message: "already_verified" });

    const rawToken = await createEmailToken(user.id, "EMAIL_VERIFY", 1440);
    const { subject, html } = verificationEmail(rawToken);
    sendEmail(user.email, subject, html)
      .then(() => emailsSentTotal.inc({ kind: "verification" }))
      .catch((err) => logger.error({ err, userId: user.id }, "Failed to resend verification email"));

    return reply.send({ ok: true });
  });

  // POST /auth/forgot-password (public, rate limited)
  const forgotPasswordBody = z.object({
    email: z.string().email(),
  });

  app.post("/forgot-password", {
    config: { rateLimit: { max: 3, timeWindow: "15 minutes" } },
  }, async (req, reply) => {
    const parsed = forgotPasswordBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_input" });
    }

    const normalized = normalizeEmail(parsed.data.email);
    const user = await findUserByEmailNormalized(normalized.emailNormalized);

    // ALWAYS return success — don't reveal whether email exists
    if (user) {
      const rawToken = await createEmailToken(user.id, "PASSWORD_RESET", 60); // 1 hour
      const { subject, html } = passwordResetEmail(rawToken);
      sendEmail(user.email, subject, html)
        .then(() => emailsSentTotal.inc({ kind: "password_reset" }))
        .catch((err) => logger.error({ err, userId: user.id }, "Failed to send password reset email"));
    }

    return reply.send({ ok: true, message: "If that email is registered, a reset link has been sent." });
  });

  // POST /auth/reset-password (public)
  const resetPasswordBody = z.object({
    token: z.string().min(1),
    password: z.string().min(8).max(72),
  });

  app.post("/reset-password", async (req, reply) => {
    const parsed = resetPasswordBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_input", details: parsed.error.flatten() });
    }

    const result = await consumeEmailToken(parsed.data.token, "PASSWORD_RESET");
    if (!result) {
      return reply.code(400).send({ ok: false, error: "invalid_or_expired_token" });
    }

    // Hash new password
    const newPasswordHash = await hashPassword(parsed.data.password);

    // Update password
    await pool.query(
      "UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2",
      [newPasswordHash, result.userId]
    );

    // Revoke ALL refresh tokens for this user (force re-login everywhere)
    await pool.query(
      "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
      [result.userId]
    );

    passwordResetsTotal.inc();

    await auditLog({
      actorUserId: result.userId,
      action: "auth.password_reset",
      targetType: "user",
      targetId: result.userId,
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
    });

    return reply.send({ ok: true });
  });
};

export default authRoutes;
