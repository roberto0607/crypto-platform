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
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import { z } from "zod";
import { createHash } from "node:crypto";

import { config } from "./config";
import { pool } from "./db/pool";

import { normalizeEmail } from "./auth/normalizeEmail";
import { hashPassword, verifyPassword } from "./auth/password";
import { createUser, findUserByEmailNormalized, findUserById, updateUserRole, listUsers } from "./auth/userRepo";
import { auditLog } from "./audit/log";
import { requireUser } from "./auth/requireUser";
import { requireRole } from "./auth/requireRole";
import { newRefreshToken, storeRefreshToken } from "./auth/refreshTokens";
import { findValidRefreshTokenByHash, revokeRefreshTokenById } from "./auth/refreshRepo";
import { REFRESH_COOKIE_NAME, refreshCookieSetOptions, refreshCookieClearOptions } from "./auth/cookieOptions";
import { createAsset, findAssetById, listActiveAssets } from "./assets/assetRepo";
import {createWallet, listWalletsByUserId, findWalletById, creditWallet, debitWallet} from "./wallets/walletRepo";
import { listLedgerEntries } from "./wallets/ledgerRepo";
import { createPair, findPairById, listActivePairs, setLastPrice } from "./trading/pairRepo";
import { findOrderById, listOrdersByUserId } from "./trading/orderRepo";
import { listTradesByOrderId } from "./trading/tradeRepo";
import { placeOrder, cancelOrder } from "./trading/matchingEngine";


async function start() {
  const app = Fastify({ logger: true });

  await app.register(cookie);

  // TODO: tighten origins for production (use env-based allowlist)
  await app.register(cors, {
    origin: ["http://localhost:5173", "http://localhost:3000"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

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

  if (!config.isProd) {
    app.get("/dev/jwt-test", async () => {
      const token = app.jwt.sign(
        { sub: "dev-user-id", role: "USER" },
        { expiresIn: config.jwtAccessTtlSeconds }
      );
      return { token };
    });
  }

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

  // -------- Phase 1.2/1.4: Login (access JWT + refresh cookie) --------
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
  // ----------------------------------------------

  // -------- Phase 1.4: Refresh (rotate refresh token, issue new access token) --------
  app.post("/auth/refresh", async (req, reply) => {
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
  // -------------------------------------------------------------------------------

  // -------- Phase 1.3: requireUser --------
  app.get("/auth/me", { preHandler: requireUser }, async (req, reply) => {
    const user = (req as any).user as { id: string; role: string };

    return reply.send({
      ok: true,
      user: { id: user.id, role: user.role },
    });
  });

  // -------- Phase 1.5: Logout (revoke refresh token + clear cookie) --------
  app.post("/auth/logout", async (req, reply) => {
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
  // ------------------------------------------------------------------------

  // -------- Phase 2: Admin Routes (RBAC) --------
  const changeRoleParams = z.object({ id: z.string().uuid() });
  const changeRoleBody = z.object({ role:z.enum(["USER", "ADMIN"]) });

  app.get("/admin/users", { preHandler: [requireUser, requireRole("ADMIN")] }, async (req, reply) => {
    const users = await listUsers();

    return reply.send({
        ok: true,
        users: users.map((u) => ({
            id: u.id,
            email: u.email,
            role: u.role,
            created_at: u.created_at,
        })),
    });
  });

  app.patch("/admin/users/:id/role", { preHandler: [requireUser, requireRole("ADMIN")] }, async (req, reply) => {
    const paramsParsed = changeRoleParams.safeParse(req.params);
    if (!paramsParsed.success) {
        return reply.code(400).send({
            ok: false,
            error: "invalid_input",
            details: paramsParsed.error.flatten(),
        });
    }

    const bodyParsed = changeRoleBody.safeParse(req.body);
    if (!bodyParsed.success) {
        return reply.code(400).send({
            ok: false,
            error: "invalid_input",
            details: bodyParsed.error?.flatten(),
        });
    }

    const targetUser = await findUserById(paramsParsed.data.id);
    if (!targetUser) {
        return reply.code(404).send({ ok: false, error: "user_not_found" });
    }

    if (targetUser.role === bodyParsed.data.role) {
        return reply.code(409).send({ ok: false, error: "role_unchanged"});
    }

    const oldRole = targetUser.role;
    const updated = await updateUserRole(targetUser.id, bodyParsed.data.role);

    const actor = (req as any).user as { id: string; role: string };

    await auditLog({
        actorUserId: actor.id,
        action: "admin.role_change",
        targetType: "user",
        targetId: targetUser.id,
        requestId: req.id,
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        metadata: { oldRole, newRole: bodyParsed.data.role },
    });

    return reply.send({
        ok: true,
        user: { id: updated!.id, email: updated!.email, role: updated!.role },
    });
  });
  // -----------------------------------------------

  // -------- Phase 3: Assets & Wallets --------
  const createAssetBody = z.object({
    symbol: z.string().min(1).max(10),
    name: z.string().min(1).max(100),
    decimals: z.number().int().min(0).max(18).default(8),
  });

  const createWalletBody = z.object({
    assetId: z.string().uuid(),
  });

  const walletIdParams = z.object({ id: z.string().uuid() });

  const creditDebitBody = z.object({
    amount: z.string().regex(/^\d+(\.\d{1,8})?$/, "Invalid amount format"),
  });

  // POST /admin/assets - create a new asset (admin only)
  app.post("/admin/assets", { preHandler: [requireUser, requireRole("ADMIN")] }, async (req, reply) => {
    const parsed = createAssetBody.safeParse(req.body);
    if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: parsed.error.flatten() });
    }

    try {
        const asset = await createAsset(parsed.data);

        const actor = (req as any).user as { id: string; role: string };
        await auditLog({
            actorUserId: actor.id,
            action: "admin.asset_create",
            targetType: "asset",
            targetId: asset.id,
            requestId: req.id,
            ip: req.ip,
            userAgent: req.headers["user-agent"] ?? null,
            metadata: { symbol: asset.symbol },
        });

        return reply.code(201).send({ ok: true, asset });
    } catch (err: any) {
        if (err?.code === "23505") {
            return reply.code(409).send({ ok: false, error: "asset_already_exists" });
        }
        throw err;
    }
  });

  // GET /assets - list active assets (authenticated)
  app.get("/assets", { preHandler: requireUser }, async (req, reply) => {
    const assets = await listActiveAssets();
    return reply.send({ ok: true, assets });
  });

  // POST /wallets - create a wallet for an asset (authenticated)
  app.post("/wallets", { preHandler: requireUser }, async (req, reply) => {
    const parsed = createWalletBody.safeParse(req.body);
    if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: parsed.error.flatten() });
    }

    const asset = await findAssetById(parsed.data.assetId);
    if (!asset || !asset.is_active) {
        return reply.code(404).send({ ok: false, error: "asset_not_found" });
    }

    const actor = (req as any).user as { id: string; role: string };

    try {
        const wallet = await createWallet(actor.id, parsed.data.assetId);
        return reply.code(201).send({ ok: true, wallet });
    } catch(err: any) {
        if (err?.code === "23505") {
            return reply.code(409).send({ ok: false, error: "wallet_already_exists" });
        }
        req.log.error({ err }, "create_wallet_failed");
        return reply.code(500).send({ ok: false, error: "server_error" });
    }
  });

  // GET /wallets - list user's wallets (authenticated)
  app.get("/wallets", { preHandler: requireUser }, async (req, reply) => {
    const actor = (req as any).user as { id: string; role: string };
    const wallets = await listWalletsByUserId(actor.id);
    return reply.send({ ok: true, wallets });
  });

  // GET /wallets/:id/transactions - ledger entries (authenticated, ownership check)
  app.get("/wallets/:id/transactions", { preHandler: requireUser }, async (req, reply) => {
    const paramsParsed = walletIdParams.safeParse(req.params);
    if (!paramsParsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: paramsParsed.error.flatten() });
    }

    const wallet = await findWalletById(paramsParsed.data.id);
    if (!wallet) {
        return reply.code(404).send({ ok: false, error: "wallet_not_found" });
    }

    const actor = (req as any).user as { id: string; role: string };
    if (wallet.user_id !== actor.id) {
        return reply.code(403).send({ ok: false, error: "forbidden" });
    }

    const entries = await listLedgerEntries(wallet.id);
    return reply.send({ ok: true, entries });
  });

  // POST /admin/wallets/:id/credit - admin credit (DB transaction)
  app.post("/admin/wallets/:id/credit", { preHandler: [requireUser, requireRole("ADMIN")] }, async (req, reply) => {
    const paramsParsed = walletIdParams.safeParse(req.params);
    if (!paramsParsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: paramsParsed.error.flatten() });
    }

    const bodyParsed = creditDebitBody.safeParse(req.body);
    if (!bodyParsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: bodyParsed.error.flatten() });
    }

    const wallet = await findWalletById(paramsParsed.data.id);
    if (!wallet) {
        return reply.code(404).send({ ok: false, error: "wallet_not_found" });
    }

    const actor = (req as any).user as { id: string; role: string };

    const result = await creditWallet(wallet.id, bodyParsed.data.amount, "ADMIN_CREDIT", { creditBy: actor.id });

    await auditLog({
        actorUserId: actor.id,
        action: "admin.wallet_credit",
        targetType: "wallet",
        targetId: wallet.id,
        requestId: req.id,
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        metadata: { amount: bodyParsed.data.amount, ledgerEntryId: result.ledgerEntryId },
    });

    return reply.send({ ok: true, wallet: result.wallet, ledgerEntryId: result.ledgerEntryId });
  });

  // POST /admin/wallets/:id/debit - admin debit (DB transaction, balance check)
  app.post("/admin/wallets/:id/debit", { preHandler: [requireUser, requireRole("ADMIN")] }, async (req, reply) => {
    const paramsParsed = walletIdParams.safeParse(req.params);
    if (!paramsParsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: paramsParsed.error.flatten() });
    }

    const bodyParsed = creditDebitBody.safeParse(req.body);
    if (!bodyParsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: bodyParsed.error.flatten() });
    }

    const wallet = await findWalletById(paramsParsed.data.id);
    if (!wallet) {
        return reply.code(404).send({ ok: false, error: "wallet_not_found" });
    }

    const actor = (req as any).user as { id: string; role: string };

    try {
        const result = await debitWallet(wallet.id, bodyParsed.data.amount, "ADMIN_DEBIT", { debitedBy: actor.id });

        await auditLog({
            actorUserId: actor.id,
            action: "admin.wallet_debit",
            targetType: "wallet",
            targetId: wallet.id,
            requestId: req.id,
            ip: req.ip,
            userAgent: req.headers["user-agent"] ?? null,
            metadata: { amount: bodyParsed.data.amount, ledgerEntryId: result.ledgerEntryId },
        });

        return reply.send({ ok: true, wallet: result.wallet, ledgerEntryId: result.ledgerEntryId });
    } catch (err: any) {
        if (err?.message === "insufficient_balance") {
            return reply.code(400).send({ ok: false, error: "insufficient_balance" });
        }
        throw err;
    }
  });

  // -------- Phase 4: Trading Engine --------
  const createPairBody = z.object({
    baseAssetId: z.string().uuid(),
    quoteAssetId: z.string().uuid(),
    symbol: z.string().min(1).max(20),
    feeBps: z.number().int().min(0).max(10000).default(30),
  });

  const pairIdParams = z.object({ id: z.string().uuid() });

  const setPriceBody = z.object({
    price: z.string().regex(/^\d+(\.\d{1,8})?$/),
  });

  const placeOrderBody = z.object({
    pairId: z.string().uuid(),
    side: z.enum(["BUY", "SELL"]),
    type: z.enum(["MARKET", "LIMIT"]),
    qty: z.string().regex(/^\d+(\.\d{1,8})?$/),
    limitPrice: z.string().regex(/^\d+(\.\d{1,8})?$/).optional(),
  }).refine(
    (data) => {
      if (data.type === "LIMIT" && !data.limitPrice) return false;
      if (data.type === "MARKET" && data.limitPrice) return false;
      return true;
    },
    { message: "limitPrice required for LIMIT orders, forbidden for MARKET orders" }
  );

  const orderIdParams = z.object({ id: z.string().uuid() });

  const listOrdersQuery = z.object({
    pairId: z.string().uuid().optional(),
    status: z.string().optional(),
  });

  const bookQuery = z.object({
    levels: z.coerce.number().int().min(1).max(100).default(20),
  });

  // POST /admin/pairs — Create trading pair
  app.post("/admin/pairs", { preHandler: [requireUser, requireRole("ADMIN")] }, async (req, reply) => {
    const parsed = createPairBody.safeParse(req.body);
    if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: parsed.error.flatten() });
    }

    const baseAsset = await findAssetById(parsed.data.baseAssetId);
    if (!baseAsset) {
        return reply.code(404).send({ ok: false, error: "asset_not_found" });
    }

    const quoteAsset = await findAssetById(parsed.data.quoteAssetId);
    if (!quoteAsset) {
        return reply.code(404).send({ ok: false, error: "asset_not_found" });
    }

    try {
        const pair = await createPair(parsed.data);

        const actor = (req as any).user as { id: string; role: string };
        await auditLog({
            actorUserId: actor.id,
            action: "pair.create",
            targetType: "trading_pair",
            targetId: pair.id,
            requestId: req.id,
            ip: req.ip,
            userAgent: req.headers["user-agent"] ?? null,
            metadata: { pairId: pair.id, symbol: pair.symbol, baseAssetId: parsed.data.baseAssetId, quoteAssetId: parsed.data.quoteAssetId, feeBps: parsed.data.feeBps },
        });

        return reply.code(201).send({ ok: true, pair });
    } catch (err: any) {
        if (err?.code === "23505") {
            return reply.code(409).send({ ok: false, error: "pair_already_exists" });
        }
        throw err;
    }
  });

  // PATCH /admin/pairs/:id/price — Set last_price
  app.patch("/admin/pairs/:id/price", { preHandler: [requireUser, requireRole("ADMIN")] }, async (req, reply) => {
    const paramsParsed = pairIdParams.safeParse(req.params);
    if (!paramsParsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: paramsParsed.error.flatten() });
    }

    const bodyParsed = setPriceBody.safeParse(req.body);
    if (!bodyParsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: bodyParsed.error.flatten() });
    }

    const existing = await findPairById(paramsParsed.data.id);
    if (!existing) {
        return reply.code(404).send({ ok: false, error: "pair_not_found" });
    }

    const pair = await setLastPrice(paramsParsed.data.id, bodyParsed.data.price);

    const actor = (req as any).user as { id: string; role: string };
    await auditLog({
        actorUserId: actor.id,
        action: "pair.price_update",
        targetType: "trading_pair",
        targetId: paramsParsed.data.id,
        requestId: req.id,
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        metadata: { pairId: paramsParsed.data.id, oldPrice: existing.last_price, newPrice: bodyParsed.data.price },
    });

    return reply.send({ ok: true, pair });
  });

  // GET /pairs — List active pairs
  app.get("/pairs", { preHandler: requireUser }, async (req, reply) => {
    const pairs = await listActivePairs();
    return reply.send({ ok: true, pairs });
  });

  // POST /orders — Place order (matching-lite)
  app.post("/orders", { preHandler: requireUser }, async (req, reply) => {
    const parsed = placeOrderBody.safeParse(req.body);
    if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: parsed.error.flatten() });
    }

    const actor = (req as any).user as { id: string; role: string };

    try {
        const result = await placeOrder(
            actor.id,
            parsed.data.pairId,
            parsed.data.side,
            parsed.data.type,
            parsed.data.qty,
            parsed.data.limitPrice
        );

        await auditLog({
            actorUserId: actor.id,
            action: "order.create",
            targetType: "order",
            targetId: result.order.id,
            requestId: req.id,
            ip: req.ip,
            userAgent: req.headers["user-agent"] ?? null,
            metadata: {
                orderId: result.order.id,
                pairId: parsed.data.pairId,
                side: parsed.data.side,
                type: parsed.data.type,
                qty: parsed.data.qty,
                limitPrice: parsed.data.limitPrice ?? null,
                status: result.order.status,
                fillCount: result.fills.length,
            },
        });

        return reply.code(201).send({ ok: true, order: result.order, fills: result.fills });
    } catch (err: any) {
        const knownErrors = ["pair_not_found", "wallet_not_found", "no_price_available", "insufficient_balance"];
        if (knownErrors.includes(err?.message)) {
            const code = ["pair_not_found", "wallet_not_found"].includes(err.message) ? 404 : 400;
            return reply.code(code).send({ ok: false, error: err.message });
        }
        throw err;
    }
  });

  // GET /orders — List user's orders
  app.get("/orders", { preHandler: requireUser }, async (req, reply) => {
    const actor = (req as any).user as { id: string; role: string };
    const queryParsed = listOrdersQuery.safeParse(req.query);
    const filters = queryParsed.success ? queryParsed.data : {};
    const orders = await listOrdersByUserId(actor.id, filters);
    return reply.send({ ok: true, orders });
  });

  // GET /orders/:id — Order detail + fills
  app.get("/orders/:id", { preHandler: requireUser }, async (req, reply) => {
    const paramsParsed = orderIdParams.safeParse(req.params);
    if (!paramsParsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: paramsParsed.error.flatten() });
    }

    const order = await findOrderById(paramsParsed.data.id);
    if (!order) {
        return reply.code(404).send({ ok: false, error: "order_not_found" });
    }

    const actor = (req as any).user as { id: string; role: string };
    if (order.user_id !== actor.id) {
        return reply.code(403).send({ ok: false, error: "forbidden" });
    }

    const trades = await listTradesByOrderId(order.id);
    return reply.send({ ok: true, order, trades });
  });

  // DELETE /orders/:id — Cancel open/partial order
  app.delete("/orders/:id", { preHandler: requireUser }, async (req, reply) => {
    const paramsParsed = orderIdParams.safeParse(req.params);
    if (!paramsParsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: paramsParsed.error.flatten() });
    }

    const actor = (req as any).user as { id: string; role: string };

    try {
        const result = await cancelOrder(actor.id, paramsParsed.data.id);

        await auditLog({
            actorUserId: actor.id,
            action: "order.cancel",
            targetType: "order",
            targetId: paramsParsed.data.id,
            requestId: req.id,
            ip: req.ip,
            userAgent: req.headers["user-agent"] ?? null,
            metadata: { orderId: paramsParsed.data.id, pairId: result.order.pair_id, releasedAmount: result.releasedAmount },
        });

        return reply.send({ ok: true, order: result.order, releasedAmount: result.releasedAmount });
    } catch (err: any) {
        if (err?.message === "order_not_found") {
            return reply.code(404).send({ ok: false, error: "order_not_found" });
        }
        if (err?.message === "forbidden") {
            return reply.code(403).send({ ok: false, error: "forbidden" });
        }
        if (err?.message === "order_not_cancelable") {
            return reply.code(400).send({ ok: false, error: "order_not_cancelable" });
        }
        throw err;
    }
  });

  // GET /pairs/:id/book — Aggregated order book
  app.get("/pairs/:id/book", { preHandler: requireUser }, async (req, reply) => {
    const paramsParsed = pairIdParams.safeParse(req.params);
    if (!paramsParsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: paramsParsed.error.flatten() });
    }

    const pair = await findPairById(paramsParsed.data.id);
    if (!pair) {
        return reply.code(404).send({ ok: false, error: "pair_not_found" });
    }

    const queryParsed = bookQuery.safeParse(req.query);
    const levels = queryParsed.success ? queryParsed.data.levels : 20;

    const bidsResult = await pool.query<{ price: string; qty: string; count: string }>(
        `
        SELECT limit_price AS price,
               SUM(qty - qty_filled)::text AS qty,
               COUNT(*)::text AS count
        FROM orders
        WHERE pair_id = $1
          AND side = 'BUY'
          AND type = 'LIMIT'
          AND status IN ('OPEN', 'PARTIALLY_FILLED')
        GROUP BY limit_price
        ORDER BY limit_price DESC
        LIMIT $2
        `,
        [paramsParsed.data.id, levels]
    );

    const asksResult = await pool.query<{ price: string; qty: string; count: string }>(
        `
        SELECT limit_price AS price,
               SUM(qty - qty_filled)::text AS qty,
               COUNT(*)::text AS count
        FROM orders
        WHERE pair_id = $1
          AND side = 'SELL'
          AND type = 'LIMIT'
          AND status IN ('OPEN', 'PARTIALLY_FILLED')
        GROUP BY limit_price
        ORDER BY limit_price ASC
        LIMIT $2
        `,
        [paramsParsed.data.id, levels]
    );

    return reply.send({
        ok: true,
        book: { bids: bidsResult.rows, asks: asksResult.rows },
    });
  });
  // -----------------------------------------------

  const port = config.port;
  const host = config.host;

  await app.listen({ port, host });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
