import type { FastifyRequest, FastifyReply } from "fastify";
import { validateApiKey } from "../security/apiKeyService";
import { checkApiKeyRateLimit } from "../security/apiKeyRateLimiter";
import { apiKeyAuthTotal, apiKeyRateLimitedTotal } from "../metrics";

type JwtPayload = {
  sub?: string;
  role?: string;
};

type AuthType = "JWT" | "API_KEY";

declare module "fastify" {
  interface FastifyRequest {
    authType?: AuthType;
    apiKeyId?: string;
    apiKeyScopes?: string[];
  }
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const authHeader = req.headers.authorization ?? "";

  if (authHeader.startsWith("ApiKey ")) {
    // ── API Key auth ──
    const rawKey = authHeader.slice(7);
    if (!rawKey) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }

    const apiKey = await validateApiKey(rawKey);
    if (!apiKey) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }

    // Rate limit check
    if (await checkApiKeyRateLimit(apiKey.id)) {
      apiKeyRateLimitedTotal.inc();
      return reply.code(429).send({
        error: { code: "API_KEY_RATE_LIMIT", message: "API key rate limit exceeded." },
      });
    }

    apiKeyAuthTotal.inc();
    req.user = { id: apiKey.user_id, role: "USER" };
    req.authType = "API_KEY";
    req.apiKeyId = apiKey.id;
    req.apiKeyScopes = apiKey.scopes;
    return;
  }

  // ── JWT auth (default) ──
  try {
    const payload = (await req.jwtVerify()) as JwtPayload;
    req.user = { id: payload.sub!, role: payload.role ?? "USER" };
    req.authType = "JWT";
  } catch {
    return reply.code(401).send({ ok: false, error: "unauthorized" });
  }
}

/**
 * Middleware factory: require a specific API key scope.
 * Only applies when authType is API_KEY; JWT users pass through.
 */
export function requireScope(scope: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.authType === "API_KEY") {
      if (!req.apiKeyScopes?.includes(scope) && !req.apiKeyScopes?.includes("admin")) {
        return reply.code(403).send({ ok: false, error: "insufficient_scope" });
      }
    }
  };
}
