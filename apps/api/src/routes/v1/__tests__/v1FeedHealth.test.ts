/**
 * v1FeedHealth.test.ts — the dev-only fault-injection route must never exist
 * in production. The plugin decides at registration time from config.isProd,
 * so each case re-imports it under a mocked config.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify from "fastify";
import client from "prom-client";

async function buildWith(isProd: boolean) {
  vi.resetModules();
  // metrics.ts/feedHealth.ts register on the shared default registry at import.
  client.register.clear();
  vi.doMock("../../../config", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../config")>();
    return { ...actual, config: { ...actual.config, isProd } };
  });
  const { default: v1FeedHealth } = await import("../v1FeedHealth");
  const app = Fastify();
  await app.register(v1FeedHealth, { prefix: "/v1" });
  await app.ready();
  return app;
}

function hasRoute(app: Awaited<ReturnType<typeof buildWith>>, method: string, url: string): boolean {
  return app.hasRoute({ method: method as "GET", url });
}

describe("v1FeedHealth route registration", () => {
  afterEach(() => {
    vi.doUnmock("../../../config");
    vi.resetModules();
  });

  it("does NOT register POST /v1/debug/feed-fault in production", async () => {
    const app = await buildWith(true);
    expect(hasRoute(app, "POST", "/v1/debug/feed-fault")).toBe(false);
    const res = await app.inject({ method: "POST", url: "/v1/debug/feed-fault", payload: { action: "block_event_loop", ms: 1 } });
    expect(res.statusCode).toBe(404);
    // the read-only health endpoint is still there
    expect(hasRoute(app, "GET", "/v1/market/feed-health")).toBe(true);
    await app.close();
  });

  it("registers POST /v1/debug/feed-fault outside production", async () => {
    const app = await buildWith(false);
    expect(hasRoute(app, "POST", "/v1/debug/feed-fault")).toBe(true);
    await app.close();
  });
});
