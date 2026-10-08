/**
 * v1FeedHealth.ts — diagnostic endpoints for the market-data path.
 *
 * GET  /v1/market/feed-health?pairId=  — feed/reconnect/event-loop health plus,
 *      for one pair, exactly what the MARKET fill engine would price off right
 *      now vs. the Kraken book the trade page displays. Backs the browser's
 *      ?debug=1 overlay. Read-only.
 * POST /v1/debug/feed-fault            — DEV ONLY (never registered when
 *      config.isProd): inject a feed close/stall or block the event loop, for
 *      reproducing the "PRICE DELAYED" banner and stale-price fills locally.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../../auth/requireUser";
import { v1HandleError } from "../../http/v1Error";
import { AppError } from "../../errors/AppError";
import { config } from "../../config";
import { logger } from "../../observability/logContext";
import { getFeedHealthSnapshot, getSymbolFeedHealth } from "../../observability/feedHealth";
import { getKrakenWsHealth, __debugFaultKrakenSocket } from "../../market/krakenWs";
import { getCoinbaseWsHealth, isCoinbaseStaleFor, __debugFaultCoinbaseSockets } from "../../feeds/coinbaseWs";
import { peekSnapshot } from "../../market/snapshotStore";
import { bookSnapshots } from "../../market/orderFlowFeatures";
import { findPairById } from "../../trading/pairRepo";
import { resolveSnapshot } from "../../trading/phase6OrderService";

const feedHealthQuery = z.object({ pairId: z.string().uuid().optional() });

const feedFaultBody = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("feed"),
        exchange: z.enum(["kraken", "coinbase"]),
        mode: z.enum(["close", "stall", "resume"]),
    }),
    z.object({
        action: z.literal("block_event_loop"),
        ms: z.number().int().min(1).max(30_000),
    }),
]);

const v1FeedHealth: FastifyPluginAsync = async (app) => {
    app.get("/market/feed-health", {
        schema: {
            tags: ["Market"],
            summary: "Market-data feed health (diagnostic)",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { pairId } = feedHealthQuery.parse(req.query);
            const now = Date.now();
            const coinbaseWs = getCoinbaseWsHealth();

            let pair = null;
            if (pairId) {
                const row = await findPairById(pairId);
                if (!row) throw new AppError("pair_not_found");
                const raw = await peekSnapshot(row.symbol);
                // Exactly what placeOrderWithSnapshot would price a MARKET order off.
                const fillSnapshot = await resolveSnapshot(req.user!.id, pairId);
                const book = bookSnapshots.get(pairId);
                pair = {
                    pairId,
                    symbol: row.symbol,
                    feeds: getSymbolFeedHealth(row.symbol),
                    fillPriceSource: {
                        source: fillSnapshot.source,
                        last: fillSnapshot.last,
                        bid: fillSnapshot.bid,
                        ask: fillSnapshot.ask,
                    },
                    // Raw Kraken ticker snapshot regardless of the 10s fill TTL
                    // (null once the Redis key expires, ~15s after the last write).
                    krakenSnapshot: raw
                        ? { last: raw.last, bid: raw.bid, ask: raw.ask, ageMs: Math.max(0, now - raw.receivedAt) }
                        : null,
                    dbLastPrice: row.last_price,
                    displayedBook: book
                        ? { bestBid: book.bids[0]?.price ?? null, bestAsk: book.asks[0]?.price ?? null, ageMs: Math.max(0, now - book.ts) }
                        : null,
                };
            }

            return reply.send({
                ok: true,
                ...getFeedHealthSnapshot(),
                kraken: getKrakenWsHealth(),
                coinbase: {
                    ...coinbaseWs,
                    lastTradeAgeMs: coinbaseWs.lastTradeAt > 0 ? now - coinbaseWs.lastTradeAt : null,
                    // Per-symbol (krakenWs.ts publishes price.tick for a symbol once
                    // Coinbase is silent on it): this pair's symbol, or any symbol.
                    krakenFallbackActive: pair
                        ? isCoinbaseStaleFor(pair.symbol, now)
                        : Object.keys(coinbaseWs.symbols).some((s) => isCoinbaseStaleFor(s, now)),
                },
                pair,
            });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    if (config.isProd) return;

    app.post("/debug/feed-fault", {
        schema: { tags: ["Debug"], summary: "DEV ONLY — inject a market-data fault" },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const body = feedFaultBody.parse(req.body);
            logger.warn({ fault: body }, "debug_feed_fault_injected");
            if (body.action === "block_event_loop") {
                // Respond first so the caller isn't stuck behind its own block.
                reply.send({ ok: true, blockedMs: body.ms });
                setImmediate(() => {
                    const until = Date.now() + body.ms;
                    while (Date.now() < until) { /* deliberate busy-wait */ }
                });
                return reply;
            }
            const affected = body.exchange === "kraken"
                ? (__debugFaultKrakenSocket(body.mode) ? 1 : 0)
                : __debugFaultCoinbaseSockets(body.mode);
            return reply.send({ ok: true, affectedSockets: affected });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1FeedHealth;
