import { describe, it, expect, vi, beforeEach } from "vitest";

/* ── Mocks ────────────────────────────────────────────────── */

vi.mock("../../security/apiKeyService", () => ({
  validateApiKey: vi.fn(),
}));

vi.mock("../../security/apiKeyRateLimiter", () => ({
  checkApiKeyRateLimit: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../metrics", () => ({
  apiKeyAuthTotal: { inc: vi.fn() },
  apiKeyRateLimitedTotal: { inc: vi.fn() },
}));

import { requireUser, requireScope } from "../requireUser";
import { validateApiKey } from "../../security/apiKeyService";
import { checkApiKeyRateLimit } from "../../security/apiKeyRateLimiter";
import type { FastifyRequest, FastifyReply } from "fastify";

/* ── Helpers ──────────────────────────────────────────────── */

function mockReq(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return {
    headers: {},
    jwtVerify: vi.fn(),
    user: undefined as any,
    authType: undefined as any,
    apiKeyId: undefined as any,
    apiKeyScopes: undefined as any,
    ...overrides,
  } as unknown as FastifyRequest;
}

function mockReply(): FastifyReply {
  const reply = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as unknown as FastifyReply;
  return reply;
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ════════════════════════════════════════════════════════════
   JWT auth
   ════════════════════════════════════════════════════════════ */

describe("requireUser — JWT auth", () => {
  it("extracts userId and role from valid JWT", async () => {
    const req = mockReq({
      headers: { authorization: "Bearer tok" },
      jwtVerify: vi.fn().mockResolvedValue({ sub: "u1", role: "ADMIN" }),
    });
    const reply = mockReply();

    await requireUser(req, reply);

    expect(req.user).toEqual({ id: "u1", role: "ADMIN" });
    expect(req.authType).toBe("JWT");
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("sets req.authType to 'JWT'", async () => {
    const req = mockReq({
      headers: { authorization: "Bearer tok" },
      jwtVerify: vi.fn().mockResolvedValue({ sub: "u2", role: "USER" }),
    });
    const reply = mockReply();

    await requireUser(req, reply);

    expect(req.authType).toBe("JWT");
  });

  it("returns 401 for expired JWT", async () => {
    const req = mockReq({
      headers: { authorization: "Bearer expired" },
      jwtVerify: vi.fn().mockRejectedValue(new Error("jwt expired")),
    });
    const reply = mockReply();

    await requireUser(req, reply);

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ error: "unauthorized" }));
  });

  it("returns 401 for invalid JWT signature", async () => {
    const req = mockReq({
      headers: { authorization: "Bearer bad" },
      jwtVerify: vi.fn().mockRejectedValue(new Error("invalid signature")),
    });
    const reply = mockReply();

    await requireUser(req, reply);

    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it("returns 401 when no authorization header present", async () => {
    const req = mockReq({
      headers: {},
      jwtVerify: vi.fn().mockRejectedValue(new Error("no auth")),
    });
    const reply = mockReply();

    await requireUser(req, reply);

    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it("defaults role to USER when missing from JWT", async () => {
    const req = mockReq({
      headers: { authorization: "Bearer tok" },
      jwtVerify: vi.fn().mockResolvedValue({ sub: "u3" }),
    });
    const reply = mockReply();

    await requireUser(req, reply);

    expect(req.user).toEqual({ id: "u3", role: "USER" });
  });
});

/* ════════════════════════════════════════════════════════════
   API Key auth
   ════════════════════════════════════════════════════════════ */

describe("requireUser — API Key auth", () => {
  it("validates API key and sets req.user", async () => {
    vi.mocked(validateApiKey).mockResolvedValueOnce({
      id: "ak1",
      user_id: "u1",
      scopes: ["read", "trade"],
      key_hash: "h",
      name: "test",
      last_used_at: null,
      created_at: "",
    } as any);

    const req = mockReq({ headers: { authorization: "ApiKey sk_live_abc123" } });
    const reply = mockReply();

    await requireUser(req, reply);

    expect(req.user).toEqual({ id: "u1", role: "USER" });
    expect(req.authType).toBe("API_KEY");
    expect(req.apiKeyId).toBe("ak1");
    expect(req.apiKeyScopes).toEqual(["read", "trade"]);
  });

  it("returns 401 for non-existent API key", async () => {
    vi.mocked(validateApiKey).mockResolvedValueOnce(null);

    const req = mockReq({ headers: { authorization: "ApiKey sk_invalid" } });
    const reply = mockReply();

    await requireUser(req, reply);

    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it("returns 429 when API key rate limit exceeded", async () => {
    vi.mocked(validateApiKey).mockResolvedValueOnce({
      id: "ak2",
      user_id: "u2",
      scopes: [],
      key_hash: "h",
      name: "test",
      last_used_at: null,
      created_at: "",
    } as any);
    vi.mocked(checkApiKeyRateLimit).mockResolvedValueOnce(true);

    const req = mockReq({ headers: { authorization: "ApiKey sk_ratelimited" } });
    const reply = mockReply();

    await requireUser(req, reply);

    expect(reply.code).toHaveBeenCalledWith(429);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: "API_KEY_RATE_LIMIT" }) }),
    );
  });

  it("returns 401 for malformed 'ApiKey' header (empty key)", async () => {
    const req = mockReq({ headers: { authorization: "ApiKey " } });
    const reply = mockReply();

    await requireUser(req, reply);

    expect(reply.code).toHaveBeenCalledWith(401);
  });
});

/* ════════════════════════════════════════════════════════════
   requireScope
   ════════════════════════════════════════════════════════════ */

describe("requireScope", () => {
  it("allows request when API key has required scope", async () => {
    const req = mockReq();
    req.authType = "API_KEY";
    req.apiKeyScopes = ["read", "trade"];
    const reply = mockReply();

    const middleware = requireScope("trade");
    await middleware(req, reply);

    expect(reply.code).not.toHaveBeenCalled();
  });

  it("returns 403 when API key lacks required scope", async () => {
    const req = mockReq();
    req.authType = "API_KEY";
    req.apiKeyScopes = ["read"];
    const reply = mockReply();

    const middleware = requireScope("trade");
    await middleware(req, reply);

    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: "insufficient_scope" }),
    );
  });

  it("always allows JWT auth (scopes only apply to API keys)", async () => {
    const req = mockReq();
    req.authType = "JWT";
    req.apiKeyScopes = undefined;
    const reply = mockReply();

    const middleware = requireScope("admin");
    await middleware(req, reply);

    expect(reply.code).not.toHaveBeenCalled();
  });

  it("allows API key with 'admin' scope to bypass scope check", async () => {
    const req = mockReq();
    req.authType = "API_KEY";
    req.apiKeyScopes = ["admin"];
    const reply = mockReply();

    const middleware = requireScope("trade");
    await middleware(req, reply);

    expect(reply.code).not.toHaveBeenCalled();
  });
});
