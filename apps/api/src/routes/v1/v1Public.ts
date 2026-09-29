/**
 * v1Public.ts — unauthenticated endpoints behind the landing page.
 *
 * GET /v1/public/landing-stream   SSE: prices, featured match, own quick-call results
 * GET /v1/handles/available?h=    handle availability for the signup CTA
 */

import type { FastifyPluginAsync } from "fastify";
import { checkHandleAvailability, HANDLE_MAX } from "../../auth/handle";
import { resolveIdentity } from "../../quickCall/identity";
import { addConnection } from "../../landing/landingBroadcaster";

const HEARTBEAT_INTERVAL_MS = 15_000;

const v1Public: FastifyPluginAsync = async (app) => {
  app.get("/public/landing-stream", {
    schema: {
      tags: ["Public"],
      summary: "Landing page live stream (SSE, no auth)",
      description:
        "Events: price {symbol, price} (BTC/ETH/SOL, ≤2/s each), featured (live match or null), " +
        "quickcall (this visitor's own settled calls — identity from the quick-call session cookie, " +
        "which GET /v1/quick-call/current issues). Max 4 concurrent streams per IP.",
    },
  }, async (req, reply) => {
    // Cookie-reading only: raw SSE bypasses Fastify's onSend, where
    // @fastify/cookie writes Set-Cookie, so the stream can't mint a session.
    const identity = await resolveIdentity(req, reply, { create: false });

    let closed = false;
    const write = (chunk: string) => {
      if (closed) return;
      try {
        reply.raw.write(chunk);
      } catch {
        cleanup();
      }
    };

    const remove = addConnection({
      ip: req.ip,
      identityKey: identity?.key ?? null,
      send: (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    });
    if (!remove) {
      return reply.code(429).send({ ok: false, error: "too_many_streams" });
    }

    reply.header("Content-Type", "text/event-stream");
    reply.header("Cache-Control", "no-cache");
    reply.header("Connection", "keep-alive");
    reply.header("X-Accel-Buffering", "no");
    reply.raw.writeHead(200, reply.getHeaders() as import("node:http").OutgoingHttpHeaders);
    reply.raw.write(": connected\n\n");

    const heartbeat = setInterval(() => write(": heartbeat\n\n"), HEARTBEAT_INTERVAL_MS);

    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      remove!();
    }
    req.raw.on("close", cleanup);
  });

  app.get("/handles/available", {
    schema: {
      tags: ["Public"],
      summary: "Is this handle free to claim?",
      querystring: {
        type: "object",
        required: ["h"],
        properties: { h: { type: "string", maxLength: HANDLE_MAX + 20 } },
      },
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            handle: { type: "string" },
            available: { type: "boolean" },
            reason: { type: "string", enum: ["invalid", "taken"] },
          },
        },
      },
    },
    // Tighter than the global 200/min: this is an unauthenticated lookup
    // the client debounces, so a real visitor needs far fewer.
    config: { rateLimit: { max: 30, timeWindow: 60_000 } },
  }, async (req, reply) => {
    const { h } = req.query as { h: string };
    const handle = h.trim();
    return reply.send({ ok: true, handle, ...(await checkHandleAvailability(handle)) });
  });
};

export default v1Public;
