/**
 * API-key scopes: what an `Authorization: ApiKey <key>` caller may do.
 *
 * Browser sessions (JWT access token + refresh cookie) are never affected:
 * every check here returns early unless req.authType === "API_KEY".
 *
 * A route's requirement comes from its config, or from its method when the
 * config is silent — so a route nobody thought about fails closed:
 *
 *   config.apiKeyScope = "read"   needs the `read` scope
 *   config.apiKeyScope = "trade"  needs the `trade` scope (orders, triggers,
 *                                 wallets, replay — anything that trades)
 *   config.apiKeyScope = "none"   session only; API keys get 403
 *   (unset) GET / HEAD            → "read"
 *   (unset) any other method      → "none"
 *
 * The `admin` scope satisfies `read` and `trade` (it never makes a "none"
 * route reachable, and API-key callers always carry the USER role).
 *
 * Separately, an API key never trades a match or a competition, whatever its
 * scopes: trade routes call rejectApiKeyOutsideFreePlay() once they know the
 * scope the request targets.
 */
import type { FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import { parseMatchScope } from "../http/matchScopeQuery";

export type ApiKeyScope = "read" | "trade";
export type ApiKeyAccess = ApiKeyScope | "none";

declare module "fastify" {
  interface FastifyContextConfig {
    /** What an API-key caller needs on this route (see auth/apiKeyScope.ts). */
    apiKeyScope?: ApiKeyAccess;
  }
}

export const API_KEY_ERROR_MESSAGES = {
  insufficient_scope: "This API key does not have the scope this endpoint requires.",
  api_key_not_allowed: "This endpoint can't be used with an API key — sign in instead.",
  api_key_scope_forbidden:
    "API keys can only trade free-play and practice. Matches and competitions require a signed-in session.",
} as const;

export type ApiKeyErrorCode = keyof typeof API_KEY_ERROR_MESSAGES;

/** The requirement for a route: its explicit config, else read for GET/HEAD and none otherwise. */
export function requiredApiKeyAccess(method: string, configured: ApiKeyAccess | undefined): ApiKeyAccess {
  if (configured) return configured;
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" ? "read" : "none";
}

export function apiKeyHasScope(scopes: readonly string[] | undefined, required: ApiKeyScope): boolean {
  return !!scopes && (scopes.includes(required) || scopes.includes("admin"));
}

/**
 * One 403 body for both route families: legacy routes read `error`, /v1 routes
 * read `code`; both get `message`.
 */
export function sendApiKeyError(
  req: FastifyRequest,
  reply: FastifyReply,
  code: ApiKeyErrorCode,
  extra: Record<string, unknown> = {},
): FastifyReply {
  req.log.warn(
    { errCode: code, reqId: req.id, method: req.method, url: req.url, apiKeyId: req.apiKeyId, ...extra },
    `api_key_rejected: ${code}`,
  );
  return reply.code(403).send({
    ok: false,
    error: code,
    code,
    message: API_KEY_ERROR_MESSAGES[code],
    requestId: req.id,
    ...extra,
  });
}

/**
 * Enforce the route's API-key requirement. Called by requireUser right after
 * an API key authenticates; returns the sent reply on rejection, else null.
 */
export function enforceApiKeyScope(req: FastifyRequest, reply: FastifyReply): FastifyReply | null {
  if (req.authType !== "API_KEY") return null;
  const required = requiredApiKeyAccess(req.method ?? "", req.routeOptions?.config?.apiKeyScope);
  if (required === "none") return sendApiKeyError(req, reply, "api_key_not_allowed");
  if (!apiKeyHasScope(req.apiKeyScopes, required)) {
    return sendApiKeyError(req, reply, "insufficient_scope", { requiredScope: required });
  }
  return null;
}

/**
 * An API key trades free-play only (that includes practicing on free-play
 * while a match runs). `matchId` is the match the request targets (null =
 * free-play); `competitionId` is the competition header, if any. Returns the
 * sent reply on rejection, else null. Session callers always pass.
 */
export function rejectApiKeyOutsideFreePlay(
  req: FastifyRequest,
  reply: FastifyReply,
  target: { matchId?: string | null; competitionId?: string | null },
): FastifyReply | null {
  if (req.authType !== "API_KEY") return null;
  if (target.matchId || target.competitionId) {
    return sendApiKeyError(req, reply, "api_key_scope_forbidden");
  }
  return null;
}

/**
 * The match a request's raw `scope` names, or null for free-play. A missing or
 * malformed scope is null here: the route's own validation still answers it
 * (scope_required / invalid_input).
 */
export function requestedMatchId(raw: unknown): string | null {
  const scope = parseMatchScope(raw);
  return typeof scope === "string" && scope !== "invalid" ? scope : null;
}

// ── Route inventory (documentation + the guard test) ──

export interface ApiKeyRouteEntry {
  method: string;
  url: string;
  /** True when the route runs requireUser (the only place API keys authenticate). */
  apiKeyAuth: boolean;
  /** What an API key needs here; null when the route never authenticates an API key. */
  access: ApiKeyAccess | null;
}

declare module "fastify" {
  interface FastifyInstance {
    /** This app's routes and what an API key needs on each (auth/apiKeyScope.ts). */
    apiKeyRoutes: readonly ApiKeyRouteEntry[];
  }
}

/**
 * onRoute hook (registered first thing in buildApp), appending to `inventory`. `authFns` are the
 * preHandlers that authenticate API keys (requireUser). `pluginAuthPrefixes`
 * are route prefixes whose plugin installs requireUser as a plugin-level hook,
 * which onRoute can't see (betaAdminRoutes).
 */
export function makeInventoryHook(
  inventory: ApiKeyRouteEntry[],
  authFns: readonly unknown[],
  pluginAuthPrefixes: readonly string[],
) {
  return (route: RouteOptions & { prefix?: string }) => {
    const handlers = route.preHandler === undefined ? [] : Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler];
    const apiKeyAuth =
      handlers.some((h) => authFns.includes(h)) ||
      pluginAuthPrefixes.some((p) => (route.prefix ?? "") === p);
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      const m = String(method).toUpperCase();
      if (m === "HEAD") continue; // implicit twin of GET
      inventory.push({
        method: m,
        url: route.url,
        apiKeyAuth,
        access: apiKeyAuth ? requiredApiKeyAccess(m, route.config?.apiKeyScope) : null,
      });
    }
  };
}
