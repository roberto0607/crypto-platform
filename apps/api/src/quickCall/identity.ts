/**
 * identity.ts — who is making a quick call: the logged-in user, or an
 * anonymous visitor identified by a signed, httpOnly session cookie.
 *
 * The cookie value is `<uuid>.<hmac>`; the HMAC key is derived from
 * JWT_ACCESS_SECRET with a fixed domain-separation label so it can never be
 * confused with a JWT signature and needs no new required env var.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";

export const ANON_COOKIE_NAME = "tradr_anon";
const ANON_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const signingKey = createHmac("sha256", config.jwtAccessSecret)
  .update("tradr.quick-call.anon-session.v1")
  .digest();

export interface Identity {
  kind: "user" | "anon";
  id: string;
  /** Storage/event key — `user:<uuid>` or `anon:<uuid>`. */
  key: string;
}

// Same cross-site rule as the refresh cookie (auth/cookieOptions.ts): prod web
// and API are different sites, so the cookie must be SameSite=None; Secure to
// be sent on the landing page's fetches. Dev goes through the Vite proxy.
export const anonCookieOptions = {
  httpOnly: true,
  secure: config.isProd,
  sameSite: (config.isProd ? "none" : "lax") as "none" | "lax",
  path: "/",
};

function sign(id: string): string {
  return createHmac("sha256", signingKey).update(id).digest("base64url");
}

export function signAnonId(id: string): string {
  return `${id}.${sign(id)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Returns the anon id if the cookie value is well-formed and correctly signed. */
export function verifyAnonCookie(value: string | undefined): string | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot < 0) return null;
  const id = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!UUID_RE.test(id)) return null;
  const expected = Buffer.from(sign(id));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return id;
}

async function userFromBearer(req: FastifyRequest): Promise<string | null> {
  if (!(req.headers.authorization ?? "").startsWith("Bearer ")) return null;
  try {
    const payload = (await req.jwtVerify()) as { sub?: string };
    return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

export function anonIdentity(id: string): Identity {
  return { kind: "anon", id, key: `anon:${id}` };
}

export function userIdentity(id: string): Identity {
  return { kind: "user", id, key: `user:${id}` };
}

/**
 * Resolve the caller's identity. A valid Bearer token wins; otherwise the
 * signed anon cookie. With `create`, a visitor with neither gets a fresh anon
 * session cookie set on `reply`.
 */
export async function resolveIdentity(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: { create: boolean },
): Promise<Identity | null> {
  const userId = await userFromBearer(req);
  if (userId) return userIdentity(userId);

  const anonId = verifyAnonCookie(req.cookies[ANON_COOKIE_NAME]);
  if (anonId) return anonIdentity(anonId);

  if (!opts.create) return null;
  const id = randomUUID();
  reply.setCookie(ANON_COOKIE_NAME, signAnonId(id), {
    ...anonCookieOptions,
    maxAge: ANON_COOKIE_MAX_AGE_SECONDS,
  });
  return anonIdentity(id);
}
