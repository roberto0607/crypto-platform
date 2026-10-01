/**
 * v1QuickCall.ts — landing-page quick calls. No login required: an anonymous
 * visitor is identified by a signed session cookie (see quickCall/identity.ts).
 *
 * POST /v1/quick-call          { direction: "UP" | "DOWN" }
 * GET  /v1/quick-call/current  open call (if any), streak, last settled rounds
 */

import type { FastifyPluginAsync } from "fastify";
import { v1HandleError } from "../../http/v1Error";
import { resolveIdentity } from "../../quickCall/identity";
import { startLatestTradeTracker } from "../../quickCall/latestTradeStore";
import { getCurrent, placeCall, QuickCallError } from "../../quickCall/quickCallService";
import type { Direction } from "../../quickCall/quickCallStore";

const openCallSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    direction: { type: "string", enum: ["UP", "DOWN"] },
    entryPrice: { type: "string" },
    entryAt: { type: "number" },
    settleAt: { type: "number" },
  },
} as const;

const errorSchema = {
  type: "object",
  properties: { ok: { type: "boolean" }, error: { type: "string" } },
} as const;

const settledCallSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    direction: { type: "string", enum: ["UP", "DOWN"] },
    entryPrice: { type: "string" },
    exitPrice: { type: "string", nullable: true },
    outcome: { type: "string", enum: ["WIN", "LOSS", "PUSH", "VOID"] },
    settledAt: { type: "number" },
  },
} as const;

const v1QuickCall: FastifyPluginAsync = async (app) => {
  startLatestTradeTracker();

  app.post("/quick-call", {
    schema: {
      tags: ["QuickCall"],
      summary: "Call BTC's direction over the next 60 seconds",
      description:
        "Entry price and outcome are server-determined. One open call per identity; 30 calls/hour per IP.",
      body: {
        type: "object",
        required: ["direction"],
        properties: { direction: { type: "string", enum: ["UP", "DOWN"] } },
      },
      response: {
        200: {
          type: "object",
          properties: { ok: { type: "boolean" }, call: openCallSchema, streak: { type: "number" } },
        },
        409: errorSchema,
        429: errorSchema,
        503: errorSchema,
      },
    },
  }, async (req, reply) => {
    try {
      const identity = (await resolveIdentity(req, reply, { create: true }))!;
      const { direction } = req.body as { direction: Direction };
      const result = await placeCall(identity, direction, req.ip);
      return reply.send({ ok: true, ...result });
    } catch (err) {
      if (err instanceof QuickCallError) {
        return reply.code(err.statusCode).send({ ok: false, error: err.code });
      }
      return v1HandleError(reply, err);
    }
  });

  app.get("/quick-call/current", {
    schema: {
      tags: ["QuickCall"],
      summary: "The caller's open quick call, streak, and last 20 settled rounds",
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            call: { ...openCallSchema, nullable: true },
            streak: { type: "number" },
            history: { type: "array", items: settledCallSchema },
          },
        },
      },
    },
  }, async (req, reply) => {
    try {
      const identity = await resolveIdentity(req, reply, { create: false });
      if (!identity) return reply.send({ ok: true, call: null, streak: 0, history: [] });
      return reply.send({ ok: true, ...(await getCurrent(identity)) });
    } catch (err) {
      return v1HandleError(reply, err);
    }
  });
};

export default v1QuickCall;
