import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../auth/requireUser";
import { findAssetById, listActiveAssets } from "../assets/assetRepo";
import { createWallet, listWalletsByUserId, findWalletById } from "../wallets/walletRepo";
import { listLedgerEntries } from "../wallets/ledgerRepo";
import { AppError } from "../errors/AppError";
import { handleError } from "../http/handleError";

// ── Zod schemas ──
const createWalletBody = z.object({
  assetId: z.string().uuid(),
});

const walletIdParams = z.object({ id: z.string().uuid() });

// ── Plugin (registered without prefix) ──
const walletRoutes: FastifyPluginAsync = async (app) => {

  // Per-route rate-limit override: /assets gets its own dedicated bucket,
  // independent of the global 100/min-per-IP limit (app.ts).
  //
  // Pattern established by PR #35 (/health, b291dd0): cold-load-critical read
  // endpoints that every tab hits on startup starve the shared global bucket
  // when ~5+ tabs cold-load from one IP. Driven by the MEDIUM follow-on filed in
  // docs/followups.md ("Other endpoints starve the global rate-limit bucket under
  // multi-tab load") — /assets is in App.tsx's cold-load batch.
  // Threshold: 60/min = 6-12x cold-load worst case (5 tabs * 1-2 init requests
  // per tab/min ≈ 5-10 req/min). Tighter than /health's 120/min — this does real
  // DB work (active-assets query), /health is cheap.
  const assetsRateLimit = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } };

  // GET /assets — list active assets (authenticated)
  app.get("/assets", { ...assetsRateLimit, schema: { tags: ["Assets"], summary: "List active assets", description: "Returns all active asset definitions.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { ok: { type: "boolean" }, assets: { type: "array", items: { type: "object", additionalProperties: true } } } } } }, preHandler: requireUser }, async (req, reply) => {
    const assets = await listActiveAssets();
    return reply.send({ ok: true, assets });
  });

  // POST /wallets — create a wallet for an asset (authenticated)
  app.post("/wallets", { schema: { tags: ["Wallets"], summary: "Create a wallet", description: "Creates a wallet for the authenticated user for a given asset.", security: [{ bearerAuth: [] }], body: { type: "object", required: ["assetId"], properties: { assetId: { type: "string", format: "uuid" } } }, response: { 201: { type: "object", properties: { ok: { type: "boolean" }, wallet: { type: "object", additionalProperties: true } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } }, 404: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } }, 409: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } }, preHandler: requireUser }, async (req, reply) => {
    const parsed = createWalletBody.safeParse(req.body);
    if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: parsed.error.flatten() });
    }

    const asset = await findAssetById(parsed.data.assetId);
    if (!asset || !asset.is_active) {
        return reply.code(404).send({ ok: false, error: "asset_not_found" });
    }

    const actor = req.user!;

    try {
        const wallet = await createWallet(actor.id, parsed.data.assetId);
        return reply.code(201).send({ ok: true, wallet });
    } catch(err: any) {
        if (err?.code === "23505") return handleError(reply, new AppError("wallet_already_exists"));
        req.log.error({ err }, "create_wallet_failed");
        return handleError(reply, new AppError("server_error"));
    }
  });

  // GET /wallets — list user's wallets (authenticated)
  // Per-route rate-limit override: /wallets gets its own dedicated bucket,
  // independent of the global 100/min-per-IP limit (app.ts).
  //
  // Pattern established by PR #35 (/health, b291dd0): cold-load-critical read
  // endpoints that every tab hits on startup starve the shared global bucket
  // when ~5+ tabs cold-load from one IP. Driven by the MEDIUM follow-on filed in
  // docs/followups.md ("Other endpoints starve the global rate-limit bucket under
  // multi-tab load") — /wallets is in App.tsx's cold-load batch.
  // Threshold: 60/min = 6-12x cold-load worst case (5 tabs * 1-2 init requests
  // per tab/min ≈ 5-10 req/min). Tighter than /health's 120/min — this does real
  // DB work (per-user wallet query), /health is cheap.
  // NOTE: applies ONLY to GET /wallets. The sibling POST /wallets and
  // GET /wallets/:id/transactions routes stay on the global 100/min default.
  const walletsRateLimit = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } };

  app.get("/wallets", { ...walletsRateLimit, schema: { tags: ["Wallets"], summary: "List user wallets", description: "Returns all wallets owned by the authenticated user.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { ok: { type: "boolean" }, wallets: { type: "array", items: { type: "object", additionalProperties: true } } } } } }, preHandler: requireUser }, async (req, reply) => {
    const actor = req.user!;
    const wallets = await listWalletsByUserId(actor.id);
    return reply.send({ ok: true, wallets });
  });

  // GET /wallets/:id/transactions — ledger entries (authenticated, ownership check)
  app.get("/wallets/:id/transactions", { schema: { tags: ["Wallets"], summary: "Wallet transactions", description: "Returns ledger entries for a specific wallet. Only accessible by the wallet owner.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" }, entries: { type: "array", items: { type: "object", additionalProperties: true } } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } }, 403: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } }, 404: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } }, preHandler: requireUser }, async (req, reply) => {
    const paramsParsed = walletIdParams.safeParse(req.params);
    if (!paramsParsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: paramsParsed.error.flatten() });
    }

    const wallet = await findWalletById(paramsParsed.data.id);
    if (!wallet) {
        return reply.code(404).send({ ok: false, error: "wallet_not_found" });
    }

    const actor = req.user!;
    if (wallet.user_id !== actor.id) {
        return reply.code(403).send({ ok: false, error: "forbidden" });
    }

    const entries = await listLedgerEntries(wallet.id);
    return reply.send({ ok: true, entries });
  });
};

export default walletRoutes;
