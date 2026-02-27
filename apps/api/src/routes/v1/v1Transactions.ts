import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser";
import { v1HandleError } from "../../http/v1Error";
import { decodeCursor, parseLimit, slicePage } from "../../http/pagination";
import { findWalletById } from "../../wallets/walletRepo";
import { listLedgerEntriesPaginated } from "../../wallets/ledgerRepo";
import { AppError } from "../../errors/AppError";

const walletIdParams = z.object({ id: z.string().uuid() });

const txQuery = z.object({
    limit: z.string().optional(),
    cursor: z.string().optional(),
});

const v1Transactions: FastifyPluginAsync = async (app) => {
    app.get("/wallets/:id/transactions", { preHandler: requireUser }, async (req, reply) => {
        try {
            const paramsParsed = walletIdParams.safeParse(req.params);
            if (!paramsParsed.success) {
                throw new AppError("invalid_input", paramsParsed.error.flatten());
            }

            const wallet = await findWalletById(paramsParsed.data.id);
            if (!wallet) {
                throw new AppError("wallet_not_found");
            }

            const actor = req.user!;
            if (wallet.user_id !== actor.id) {
                throw new AppError("forbidden");
            }

            const queryParsed = txQuery.safeParse(req.query);
            const q = queryParsed.success ? queryParsed.data : {};

            const limit = parseLimit(q.limit);
            const cursor = decodeCursor<{ ca: string; id: string }>(q.cursor);

            const rows = await listLedgerEntriesPaginated(wallet.id, limit, cursor);

            const page = slicePage(rows, limit, (row) => ({
                ca: row.created_at,
                id: row.id,
            }));

            return reply.send(page);
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Transactions;
