import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../auth/requireUser";
import { requireRole } from "../auth/requireRole";
import { auditLog } from "../audit/log";
import { findUserById, updateUserRole, listUsers } from "../auth/userRepo";
import { createAsset, findAssetById } from "../assets/assetRepo";
import { findWalletById, creditWallet, debitWallet } from "../wallets/walletRepo";
import { createPair, findPairById, setLastPrice } from "../trading/pairRepo";
import { AppError } from "../errors/AppError";
import { handleError } from "../http/handleError";
import { pool } from "../db/pool";
import { getQueueStats } from "../queue/queueManager";

// ── Zod schemas ──
const changeRoleParams = z.object({ id: z.string().uuid() });
const changeRoleBody = z.object({ role: z.enum(["USER", "ADMIN"]) });

const createAssetBody = z.object({
  symbol: z.string().min(1).max(10),
  name: z.string().min(1).max(100),
  decimals: z.number().int().min(0).max(18).default(8),
});

const walletIdParams = z.object({ id: z.string().uuid() });

const creditDebitBody = z.object({
  amount: z.string().regex(/^\d+(\.\d{1,8})?$/, "Invalid amount format"),
});

const createPairBody = z.object({
  baseAssetId: z.string().uuid(),
  quoteAssetId: z.string().uuid(),
  symbol: z.string().min(1).max(20),
  feeBps: z.number().int().min(0).max(10000).default(30),
  makerFeeBps: z.number().int().min(0).max(10000).default(2),
  takerFeeBps: z.number().int().min(0).max(10000).default(5),
});

const pairIdParams = z.object({ id: z.string().uuid() });

const setPriceBody = z.object({
  price: z.string().regex(/^\d+(\.\d{1,8})?$/),
});


// ── Plugin (registered with prefix "/admin") ──
const adminRoutes: FastifyPluginAsync = async (app) => {

  // GET /admin/users
  app.get("/users", { schema: { tags: ["Admin"], summary: "List all users", description: "Returns all registered users. Requires ADMIN role.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { ok: { type: "boolean" }, users: { type: "array", items: { type: "object", additionalProperties: true } } } } } }, preHandler: [requireUser, requireRole("ADMIN")] }, async (req, reply) => {
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

  // PATCH /admin/users/:id/role
  app.patch("/users/:id/role", { schema: { tags: ["Admin"], summary: "Change user role", description: "Updates a user's role to USER or ADMIN. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } }, body: { type: "object", required: ["role"], properties: { role: { type: "string", enum: ["USER", "ADMIN"] } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" }, user: { type: "object", additionalProperties: true } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } }, 404: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } }, 409: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } }, preHandler: [requireUser, requireRole("ADMIN")] }, async (req, reply) => {
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

    const actor = req.user!;

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

  // POST /admin/assets
  app.post("/assets", { schema: { tags: ["Admin"], summary: "Create an asset", description: "Creates a new asset definition. Requires ADMIN role.", security: [{ bearerAuth: [] }], body: { type: "object", required: ["symbol", "name"], properties: { symbol: { type: "string", minLength: 1, maxLength: 10 }, name: { type: "string", minLength: 1, maxLength: 100 }, decimals: { type: "integer", minimum: 0, maximum: 18, default: 8 } } }, response: { 201: { type: "object", properties: { ok: { type: "boolean" }, asset: { type: "object", additionalProperties: true } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } }, 409: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } }, preHandler: [requireUser, requireRole("ADMIN")] }, async (req, reply) => {
    const parsed = createAssetBody.safeParse(req.body);
    if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: parsed.error.flatten() });
    }

    try {
        const asset = await createAsset(parsed.data);

        const actor = req.user!;
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
        if (err?.code === "23505") return handleError(reply, new AppError("asset_already_exists"));
        throw err;
    }
  });

  // POST /admin/wallets/:id/credit
  app.post("/wallets/:id/credit", { schema: { tags: ["Admin"], summary: "Credit a wallet", description: "Adds funds to a wallet. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } }, body: { type: "object", required: ["amount"], properties: { amount: { type: "string", pattern: "^\\d+(\\.\\d{1,8})?$" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" }, wallet: { type: "object", additionalProperties: true }, ledgerEntryId: { type: "string" } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } }, 404: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } }, preHandler: [requireUser, requireRole("ADMIN")] }, async (req, reply) => {
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

    const actor = req.user!;

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

  // POST /admin/wallets/:id/debit
  app.post("/wallets/:id/debit", { schema: { tags: ["Admin"], summary: "Debit a wallet", description: "Removes funds from a wallet. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } }, body: { type: "object", required: ["amount"], properties: { amount: { type: "string", pattern: "^\\d+(\\.\\d{1,8})?$" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" }, wallet: { type: "object", additionalProperties: true }, ledgerEntryId: { type: "string" } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } }, 404: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } }, preHandler: [requireUser, requireRole("ADMIN")] }, async (req, reply) => {
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

    const actor = req.user!;

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
    } catch (err) {
        return handleError(reply, err);
    }
  });

  // POST /admin/pairs
  app.post("/pairs", { schema: { tags: ["Admin"], summary: "Create a trading pair", description: "Creates a new trading pair from base and quote assets. Requires ADMIN role.", security: [{ bearerAuth: [] }], body: { type: "object", required: ["baseAssetId", "quoteAssetId", "symbol"], properties: { baseAssetId: { type: "string", format: "uuid" }, quoteAssetId: { type: "string", format: "uuid" }, symbol: { type: "string" }, feeBps: { type: "integer", default: 30 }, makerFeeBps: { type: "integer", default: 2 }, takerFeeBps: { type: "integer", default: 5 } } }, response: { 201: { type: "object", properties: { ok: { type: "boolean" }, pair: { type: "object", additionalProperties: true } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } }, 404: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } }, 409: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } }, preHandler: [requireUser, requireRole("ADMIN")] }, async (req, reply) => {
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
        const pair = await createPair({
            baseAssetId: parsed.data.baseAssetId,
            quoteAssetId: parsed.data.quoteAssetId,
            symbol: parsed.data.symbol,
            feeBps: parsed.data.feeBps,
            makerFeeBps: parsed.data.makerFeeBps,
            takerFeeBps: parsed.data.takerFeeBps,
        });

        const actor = req.user!;
        await auditLog({
            actorUserId: actor.id,
            action: "pair.create",
            targetType: "trading_pair",
            targetId: pair.id,
            requestId: req.id,
            ip: req.ip,
            userAgent: req.headers["user-agent"] ?? null,
            metadata: { pairId: pair.id, symbol: pair.symbol, baseAssetId: parsed.data.baseAssetId, quoteAssetId: parsed.data.quoteAssetId, feeBps: parsed.data.feeBps, makerFeeBps: parsed.data.makerFeeBps, takerFeeBps: parsed.data.takerFeeBps },
        });

        return reply.code(201).send({ ok: true, pair });
    } catch (err: any) {
        if (err?.code === "23505") return handleError(reply, new AppError("pair_already_exists"));
        throw err;
    }
  });

  // PATCH /admin/pairs/:id/price
  app.patch("/pairs/:id/price", { schema: { tags: ["Admin"], summary: "Set pair last price", description: "Manually sets the last price for a trading pair. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } }, body: { type: "object", required: ["price"], properties: { price: { type: "string", pattern: "^\\d+(\\.\\d{1,8})?$" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" }, pair: { type: "object", additionalProperties: true } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } }, 404: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } }, preHandler: [requireUser, requireRole("ADMIN")] }, async (req, reply) => {
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

    const actor = req.user!;
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

  // GET /admin/queue — Queue stats per trading pair
  app.get("/queue", { schema: { tags: ["Admin"], summary: "Queue statistics", description: "Returns order queue depth per trading pair. Requires ADMIN role.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { ok: { type: "boolean" }, queues: { type: "array", items: { type: "object", additionalProperties: true } } } } } }, preHandler: [requireUser, requireRole("ADMIN")] }, async (_req, reply) => {
    const queues = await getQueueStats();
    return reply.send({ ok: true, queues });
  });
};

export default adminRoutes;
