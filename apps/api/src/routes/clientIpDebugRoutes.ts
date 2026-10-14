/**
 * TEMPORARY — remove once the production proxy chain is known.
 *
 * GET /debug/client-ip logs ONE line (`client_ip_debug`) describing how the
 * request reached the process: the TCP peer, Fastify's trusted-hop view, and
 * the proxy/CDN headers that carry addresses. It returns 204 with an empty
 * body, so it tells the caller nothing; the output only shows up in the
 * service logs.
 *
 * Why: with TRUST_PROXY_HOPS=1, clientIp() resolved to a CDN77 address
 * (152.233.47.x) instead of the visitor or a Cloudflare edge, so the real hop
 * layout differs from "Cloudflare → Railway edge → app".
 *
 * Only address-carrying headers are logged by value. Every other header is
 * logged by NAME only, so cookies, Authorization and anything else sensitive
 * never reach the logs.
 */
import type { FastifyPluginAsync } from "fastify";
import { clientIp } from "../http/clientIp";

const LOGGED_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
  "true-client-ip",
  "cf-connecting-ip",
  "cf-connecting-ipv6",
  "cf-ray",
  "cf-worker",
  "cdn-loop",
  "via",
  "x-railway-edge",
  "host",
  "x-forwarded-host",
] as const;

const MAX_LEN = 512;

function headerValue(v: string | string[] | undefined): string | string[] | null {
  if (v === undefined) return null;
  if (Array.isArray(v)) return v.map((s) => s.slice(0, MAX_LEN));
  return v.slice(0, MAX_LEN);
}

const clientIpDebugRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/debug/client-ip",
    { config: { rateLimit: { max: 5, timeWindow: 60_000 } } },
    async (req, reply) => {
      const headers: Record<string, string | string[] | null> = {};
      for (const name of LOGGED_HEADERS) headers[name] = headerValue(req.headers[name]);

      req.log.info(
        {
          event: "client_ip_debug",
          socketRemoteAddress: req.socket.remoteAddress ?? null,
          reqIp: req.ip,
          reqIps: req.ips ?? null,
          resolvedClientIp: clientIp(req),
          headers,
          headerNames: Object.keys(req.headers).sort(),
        },
        "client_ip_debug",
      );
      return reply.code(204).send();
    },
  );
};

export default clientIpDebugRoutes;
