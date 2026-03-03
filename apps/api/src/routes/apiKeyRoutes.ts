import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../auth/requireUser";
import { generateApiKey, hashApiKey } from "../security/apiKeyService";
import { createApiKey, revokeApiKey, listApiKeysForUser } from "../security/apiKeyRepo";
import { auditLog } from "../audit/log";
import { apiKeyCreatedTotal, apiKeyRevokedTotal } from "../metrics";

const VALID_SCOPES = ["read", "trade", "admin"] as const;

const createBody = z.object({
  label: z.string().min(1).max(100),
  scopes: z.array(z.enum(VALID_SCOPES)).min(1),
  expiresAt: z.string().datetime().optional(),
});

const apiKeyRoutes: FastifyPluginAsync = async (app) => {

  // POST /api-keys — Create a new API key (JWT auth only)
  app.post("/", { preHandler: requireUser }, async (req, reply) => {
    // Only allow JWT-authenticated users to create keys
    if (req.authType === "API_KEY") {
      return reply.code(403).send({ ok: false, error: "forbidden" });
    }

    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_input",
        details: parsed.error.flatten(),
      });
    }

    const rawKey = generateApiKey();
    const keyHash = hashApiKey(rawKey);

    const row = await createApiKey({
      userId: req.user!.id,
      keyHash,
      label: parsed.data.label,
      scopes: parsed.data.scopes,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    });

    apiKeyCreatedTotal.inc();

    await auditLog({
      actorUserId: req.user!.id,
      action: "api_key.created",
      targetType: "api_key",
      targetId: row.id,
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
      metadata: { label: parsed.data.label, scopes: parsed.data.scopes },
    });

    return reply.code(201).send({
      ok: true,
      id: row.id,
      rawKey,
    });
  });

  // GET /api-keys — List user's API keys
  app.get("/", { preHandler: requireUser }, async (req, reply) => {
    const keys = await listApiKeysForUser(req.user!.id);

    return reply.send({
      ok: true,
      keys: keys.map((k) => ({
        id: k.id,
        label: k.label,
        scopes: k.scopes,
        lastUsedAt: k.last_used_at,
        revoked: k.revoked,
        expiresAt: k.expires_at,
        createdAt: k.created_at,
      })),
    });
  });

  // POST /api-keys/:id/revoke — Revoke an API key
  app.post("/:id/revoke", { preHandler: requireUser }, async (req, reply) => {
    // Only allow JWT-authenticated users to revoke keys
    if (req.authType === "API_KEY") {
      return reply.code(403).send({ ok: false, error: "forbidden" });
    }

    const { id } = req.params as { id: string };

    const revoked = await revokeApiKey(id, req.user!.id);
    if (!revoked) {
      return reply.code(404).send({ ok: false, error: "api_key_not_found" });
    }

    apiKeyRevokedTotal.inc();

    await auditLog({
      actorUserId: req.user!.id,
      action: "api_key.revoked",
      targetType: "api_key",
      targetId: id,
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
    });

    return reply.send({ ok: true });
  });
};

export default apiKeyRoutes;
