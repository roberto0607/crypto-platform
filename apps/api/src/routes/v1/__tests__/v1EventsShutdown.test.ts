/**
 * Audit 2026-11 H-01 (server side): on shutdown the API stopped accepting
 * connections but kept every open SSE stream alive — pings included — until
 * app.close() gave up (~2.5 min in a live repro). Browsers sat on a
 * live-looking stream with no prices and nothing to react to. Shutdown must
 * end the streams first so clients see the close at once and reconnect.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { buildApp } from "../../../app";
import { closeAllEventStreams, __clearStreamsForTest } from "../v1Events";

const buildOpts = {
  logger: false,
  disableKrakenFeed: true,
  disableTriggerEngine: true,
  disableJobRunner: true,
  disableOutboxWorker: true,
  disableLockSampler: true,
};

/** Open GET /v1/events and resolve once the stream.ready frame arrived. */
async function openStream(app: FastifyInstance) {
  const { port } = app.server.address() as AddressInfo;
  const token = app.jwt.sign({ sub: "33333333-3333-3333-3333-333333333333", role: "USER" }, { expiresIn: 3600 });
  const res = await fetch(`http://127.0.0.1:${port}/v1/events`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain("event: stream.ready");
  /** Resolves true when the server ends the stream (reads until done). */
  const ended = (async () => { for (;;) { const r = await reader.read().catch(() => ({ done: true })); if (r.done) return true; } })();
  return { ended };
}

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);

describe("SSE streams end on shutdown", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    __clearStreamsForTest();
    if (app) await within(app.close(), 2000);
    app = null;
  });

  it("closeAllEventStreams() ends every open stream at once", async () => {
    app = await buildApp(buildOpts);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const a = await openStream(app);
    const b = await openStream(app);

    expect(closeAllEventStreams()).toBe(2);
    expect(await within(a.ended, 1000)).toBe(true);
    expect(await within(b.ended, 1000)).toBe(true);

    // A client retrying during the rest of shutdown is turned away, not reattached.
    const { port } = app.server.address() as AddressInfo;
    const token = app.jwt.sign({ sub: "33333333-3333-3333-3333-333333333333", role: "USER" }, { expiresIn: 3600 });
    const retry = await fetch(`http://127.0.0.1:${port}/v1/events`, { headers: { authorization: `Bearer ${token}` } });
    expect(retry.status).toBe(503);
  });

  it("app.close() ends open streams instead of waiting on them", async () => {
    app = await buildApp(buildOpts);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const s = await openStream(app);

    const closing = app.close();
    expect(await within(s.ended, 1000)).toBe(true);
    expect(await within(closing, 2000)).not.toBe("timeout");
    app = null;
  });
});
