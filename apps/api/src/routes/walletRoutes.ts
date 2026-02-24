import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../auth/requireUser";
import { findAssetById, listActiveAssets } from "../assets/assetRepo";
import { createWallet, listWalletsByUserId, findWalletById } from "../wallets/walletRepo";
import { listLedgerEntries } from "../wallets/ledgerRepo";

// ── Zod schemas ──
const createWalletBody = z.object({
  assetId: z.string().uuid(),
});

const walletIdParams = z.object({ id: z.string().uuid() });

// ── Plugin (registered without prefix) ──
const walletRoutes: FastifyPluginAsync = async (app) => {

  // GET /assets — list active assets (authenticated)
  app.get("/assets", { preHandler: requireUser }, async (req, reply) => {
    const assets = await listActiveAssets();
    return reply.send({ ok: true, assets });
  });

  // POST /wallets — create a wallet for an asset (authenticated)
  app.post("/wallets", { preHandler: requireUser }, async (req, reply) => {
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
        if (err?.code === "23505") {
            return reply.code(409).send({ ok: false, error: "wallet_already_exists" });
        }
        req.log.error({ err }, "create_wallet_failed");
        return reply.code(500).send({ ok: false, error: "server_error" });
    }
  });

  // GET /wallets — list user's wallets (authenticated)
  app.get("/wallets", { preHandler: requireUser }, async (req, reply) => {
    const actor = req.user!;
    const wallets = await listWalletsByUserId(actor.id);
    return reply.send({ ok: true, wallets });
  });

  // GET /wallets/:id/transactions — ledger entries (authenticated, ownership check)
  app.get("/wallets/:id/transactions", { preHandler: requireUser }, async (req, reply) => {
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
