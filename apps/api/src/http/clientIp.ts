/**
 * The real client IP behind Cloudflare → Railway edge → this process.
 *
 * Fastify's `req.ip` honors TRUST_PROXY_HOPS (http/trustProxy.ts). With the
 * production default of 1 hop it is the address Railway's edge saw, i.e. the
 * right-most X-Forwarded-For entry. For playtradr.com traffic that is a
 * Cloudflare edge server, shared by every visitor on the same PoP, so keying
 * anything on it would lump unrelated users together.
 *
 * Cloudflare puts the visitor's address in CF-Connecting-IP. That header is
 * only trustworthy when the request really arrived from Cloudflare: anyone can
 * hit the *.up.railway.app domain directly and send their own
 * CF-Connecting-IP. So we honor it only when the edge address is inside
 * Cloudflare's published ranges; otherwise the edge address IS the client.
 *
 * Residual gap: the range check proves "came from Cloudflare", not "came from
 * our Cloudflare zone" — another Cloudflare customer's Worker could reach the
 * origin. Closing that needs Authenticated Origin Pulls (dashboard config).
 * Acceptable here: every consumer (rate limits, login lockout, audit log) is a
 * fairness/forensics control, not an auth boundary.
 *
 * Refresh the ranges with `pnpm cf-ips:check` (scripts/checkCloudflareIps.ts);
 * runbook in docs/runbooks/client-ip.md.
 */
import { BlockList, isIP } from "node:net";
import type { FastifyRequest } from "fastify";
import { config } from "../config";
import { CLOUDFLARE_IPV4_RANGES, CLOUDFLARE_IPV6_RANGES } from "./cloudflareRanges";

const cloudflareRanges = new BlockList();
for (const cidr of CLOUDFLARE_IPV4_RANGES) {
  const [net, prefix] = cidr.split("/");
  cloudflareRanges.addSubnet(net!, Number(prefix), "ipv4");
}
for (const cidr of CLOUDFLARE_IPV6_RANGES) {
  const [net, prefix] = cidr.split("/");
  cloudflareRanges.addSubnet(net!, Number(prefix), "ipv6");
}

/** "::ffff:1.2.3.4" → "1.2.3.4"; trims whitespace. Other input unchanged. */
function normalizeIp(raw: string): string {
  const ip = raw.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped ? mapped[1]! : ip;
}

export function isCloudflareIp(raw: string): boolean {
  const ip = normalizeIp(raw);
  const family = isIP(ip);
  if (family === 4) return cloudflareRanges.check(ip, "ipv4");
  if (family === 6) return cloudflareRanges.check(ip, "ipv6");
  return false;
}

/**
 * Pure resolution: `edgeIp` is Fastify's req.ip, `cfConnectingIp` the raw
 * header value. CF-Connecting-IP wins only when `trustCloudflare` is on, the
 * edge is a Cloudflare address, and the header is a single valid IP.
 */
export function resolveClientIp(
  edgeIp: string,
  cfConnectingIp: string | string[] | undefined,
  trustCloudflare: boolean,
): string {
  const edge = normalizeIp(edgeIp);
  if (!trustCloudflare || typeof cfConnectingIp !== "string") return edge;
  if (!isCloudflareIp(edge)) return edge;
  const candidate = normalizeIp(cfConnectingIp);
  return isIP(candidate) ? candidate : edge;
}

/** The real client IP for this request. Use this instead of `req.ip`. */
export function clientIp(req: FastifyRequest): string {
  return resolveClientIp(req.ip, req.headers["cf-connecting-ip"], config.trustCloudflareConnectingIp);
}
