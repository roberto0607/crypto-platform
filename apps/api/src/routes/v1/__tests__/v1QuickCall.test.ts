/**
 * v1QuickCall.test.ts — POST /v1/quick-call + GET /v1/quick-call/current,
 * and the anon → user streak transfer on login/register.
 *
 * Time and settlement are driven explicitly: the service's clock is pinned
 * and its scheduler captures the settle callbacks instead of setTimeout-ing.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../app";
import { pool } from "../../../db/pool";
import { ensureMigrations, resetTestData } from "../../../testing/resetDb";
import { createTestUser } from "../../../testing/fixtures";
import { subscribeGlobal, unsubscribe, type EventHandler } from "../../../events/eventBus";
import type { AppEvent, QuickCallSettledData } from "../../../events/eventTypes";
import { recordTrade, __resetLatestTradesForTest } from "../../../quickCall/latestTradeStore";
import { __resetQuickCallStoreForTest } from "../../../quickCall/quickCallStore";
import { ANON_COOKIE_NAME } from "../../../quickCall/identity";
import {
  clock,
  scheduler,
  settleCall,
  CALL_DURATION_MS,
  IP_CALLS_PER_HOUR,
  SETTLE_GRACE_MS,
} from "../../../quickCall/quickCallService";

const buildOpts = {
  logger: false,
  disableKrakenFeed: true,
  disableTriggerEngine: true,
  disableJobRunner: true,
  disableOutboxWorker: true,
  disableLockSampler: true,
  disableOrchestrator: true,
} as const;

let now = 1_800_000_000_000;
let pendingSettles: Array<() => void> = [];

function setPrice(price: string, at: number = now) {
  recordTrade("BTC/USD", price, at);
}

function anonCookieFrom(res: { cookies: Array<{ name: string; value: string }> }): string {
  const c = res.cookies.find((x) => x.name === ANON_COOKIE_NAME);
  if (!c) throw new Error("no anon cookie set");
  return `${ANON_COOKIE_NAME}=${c.value}`;
}

describe("Quick call", () => {
  let app: FastifyInstance;
  const realNow = clock.now;
  const realSchedule = scheduler.schedule;

  beforeAll(async () => {
    await ensureMigrations();
    app = await buildApp(buildOpts);
    await app.ready();
    clock.now = () => now;
    scheduler.schedule = (fn) => {
      pendingSettles.push(fn);
    };
  });

  afterAll(async () => {
    clock.now = realNow;
    scheduler.schedule = realSchedule;
    await app.close();
  });

  beforeEach(async () => {
    await resetTestData();
    __resetQuickCallStoreForTest();
    __resetLatestTradesForTest();
    pendingSettles = [];
    now += 60 * 60 * 1000; // fresh IP rate-limit window per test
    setPrice("84000.00");
  });

  async function place(direction: "UP" | "DOWN", cookie?: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/v1/quick-call",
      headers: cookie ? { cookie } : {},
      payload: { direction, ...extra },
    });
  }

  async function current(headers: Record<string, string>) {
    const res = await app.inject({ method: "GET", url: "/v1/quick-call/current", headers });
    return res.json() as { call: unknown; streak: number; history: Array<{ outcome: string; exitPrice: string | null }> };
  }

  /** Advance to settle time with a fresh exit price and fire the captured timer. */
  async function settleAt(exitPrice: string) {
    now += CALL_DURATION_MS;
    setPrice(exitPrice);
    const fns = pendingSettles;
    pendingSettles = [];
    fns.forEach((fn) => fn());
    await new Promise((r) => setImmediate(r));
  }

  async function winOnce(cookie: string) {
    expect((await place("UP", cookie)).statusCode).toBe(200);
    await settleAt(String(84000 + 100));
    setPrice("84000.00");
  }

  it("issues a signed anon session cookie and records the server's price as entry", async () => {
    const res = await place("UP");
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === ANON_COOKIE_NAME)!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite?.toLowerCase()).toBe("lax"); // every env; prod adds Secure (auth/__tests__/cookieOptions.test.ts)
    const { call } = res.json();
    expect(call.entryPrice).toBe("84000.00");
    expect(call.entryAt).toBe(now);
    expect(call.settleAt).toBe(now + CALL_DURATION_MS);
  });

  it("ignores any client-supplied price, result, or timing", async () => {
    const res = await place("UP", undefined, {
      entryPrice: "1.00",
      exitPrice: "999999",
      outcome: "WIN",
      result: "WIN",
      streak: 5,
      settleAt: now,
    });
    expect(res.statusCode).toBe(200);
    const { call, streak } = res.json();
    expect(call.entryPrice).toBe("84000.00");
    expect(call.settleAt).toBe(now + CALL_DURATION_MS);
    expect(streak).toBe(0);

    // And the client can't settle it early: nothing happens before t+60.
    const cookie = anonCookieFrom(res);
    expect((await current({ cookie })).history).toHaveLength(0);
  });

  it("rejects a direction outside UP/DOWN", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/quick-call", payload: { direction: "SIDEWAYS" } });
    expect(res.statusCode).toBe(400);
  });

  it("allows only one open call per identity", async () => {
    const first = await place("UP");
    const cookie = anonCookieFrom(first);
    const second = await place("DOWN", cookie);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("call_already_open");
  });

  it("settles a win at t+60 and increments the streak", async () => {
    const cookie = anonCookieFrom(await place("UP"));
    await settleAt("84000.01");
    const state = await current({ cookie });
    expect(state.call).toBeNull();
    expect(state.streak).toBe(1);
    expect(state.history[0]).toMatchObject({ outcome: "WIN", exitPrice: "84000.01" });
  });

  it("settles a loss and resets the streak", async () => {
    const cookie = anonCookieFrom(await place("UP"));
    await settleAt("84001");
    setPrice("84000.00");
    await place("DOWN", cookie);
    await settleAt("84000.50");
    const state = await current({ cookie });
    expect(state.history[0]!.outcome).toBe("LOSS");
    expect(state.streak).toBe(0);
  });

  it("an exact tie is a push and leaves the streak unchanged", async () => {
    const cookie = anonCookieFrom(await place("UP"));
    await settleAt("84001");
    setPrice("84000.00");
    await place("UP", cookie);
    await settleAt("84000.00");
    const state = await current({ cookie });
    expect(state.history[0]!.outcome).toBe("PUSH");
    expect(state.streak).toBe(1);
  });

  it("a feed stale > 5s at settle time voids the call and leaves the streak unchanged", async () => {
    const cookie = anonCookieFrom(await place("UP"));
    await settleAt("84001");
    await place("UP", cookie);
    // Last trade arrived 6s before settle time — way up, but stale.
    now += CALL_DURATION_MS;
    setPrice("90000", now - 6_000);
    pendingSettles.forEach((fn) => fn());
    await new Promise((r) => setImmediate(r));
    const state = await current({ cookie });
    expect(state.history[0]).toMatchObject({ outcome: "VOID", exitPrice: null });
    expect(state.streak).toBe(1);
  });

  it("a call whose settle timer was lost is voided on the next read, not settled on a later price", async () => {
    const cookie = anonCookieFrom(await place("UP"));
    pendingSettles = []; // simulate the instance dying
    now += CALL_DURATION_MS + SETTLE_GRACE_MS + 1;
    setPrice("99999");
    const state = await current({ cookie });
    expect(state.call).toBeNull();
    expect(state.history[0]!.outcome).toBe("VOID");
    expect(state.streak).toBe(0);
  });

  it("caps the streak at 5", async () => {
    const cookie = anonCookieFrom(await place("UP"));
    await settleAt("84100");
    setPrice("84000.00");
    for (let i = 0; i < 6; i++) await winOnce(cookie);
    expect((await current({ cookie })).streak).toBe(5);
  });

  it("refuses to open a call on a stale feed", async () => {
    setPrice("84000", now - 6_000);
    const res = await place("UP");
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("price_feed_stale");
  });

  it("limits each IP to 30 calls per hour", async () => {
    for (let i = 0; i < IP_CALLS_PER_HOUR; i++) {
      expect((await place("UP")).statusCode).toBe(200); // fresh anon identity each time
    }
    const res = await place("UP");
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("rate_limited");
  });

  it("treats a forged cookie as a brand-new visitor", async () => {
    const victim = anonCookieFrom(await place("UP"));
    await settleAt("84100");
    const victimId = victim.split("=")[1]!.split(".")[0]!;
    const forged = `${ANON_COOKIE_NAME}=${victimId}.not-the-signature`;
    const state = await current({ cookie: forged });
    expect(state.streak).toBe(0);
    expect(state.history).toHaveLength(0);
  });

  it("pushes the result to the caller's identity only", async () => {
    const seen: Array<{ userId?: string; data: QuickCallSettledData }> = [];
    const handler: EventHandler = (e: AppEvent) => {
      if (e.type === "quickcall.settled") seen.push({ userId: e.userId, data: e.data });
    };
    subscribeGlobal(handler);
    try {
      const res = await place("DOWN");
      const anonId = anonCookieFrom(res).split("=")[1]!.split(".")[0];
      await settleAt("83999");
      expect(seen).toHaveLength(1);
      expect(seen[0]!.userId).toBe(`anon:${anonId}`);
      expect(seen[0]!.data).toMatchObject({ outcome: "WIN", streak: 1, direction: "DOWN" });
    } finally {
      unsubscribe(handler);
    }
  });

  it("settleCall is idempotent — a second settle of the same call is a no-op", async () => {
    const res = await place("UP");
    const anonId = anonCookieFrom(res).split("=")[1]!.split(".")[0];
    const callId = res.json().call.id;
    await settleAt("84100");
    expect(await settleCall(`anon:${anonId}`, callId)).toBeNull();
    expect((await current({ cookie: anonCookieFrom(res) })).streak).toBe(1);
  });

  it("transfers the anon streak to the user on login and deletes the anon state", async () => {
    const user = await createTestUser(pool, { email: "qc-login@test.com" });
    const cookie = anonCookieFrom(await place("UP"));
    await settleAt("84100");
    setPrice("84000.00");
    await winOnce(cookie);
    expect((await current({ cookie })).streak).toBe(2);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { cookie },
      payload: { email: user.email, password: user.password },
    });
    expect(login.statusCode).toBe(200);
    const cleared = login.cookies.find((c) => c.name === ANON_COOKIE_NAME);
    expect(cleared?.value).toBe("");

    const token = login.json().accessToken as string;
    expect((await current({ authorization: `Bearer ${token}` })).streak).toBe(2);
    expect((await current({ cookie })).streak).toBe(0);
  });

  it("transfers the anon streak on register", async () => {
    const cookie = anonCookieFrom(await place("UP"));
    await settleAt("84100");
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      headers: { cookie },
      payload: { email: "qc-new@test.com", password: "correct-horse-battery" },
    });
    expect(res.statusCode).toBe(201);
    const userId = res.json().user.id as string;
    const token = app.jwt.sign({ sub: userId, role: "USER" }, { expiresIn: 3600 });
    expect((await current({ authorization: `Bearer ${token}` })).streak).toBe(1);
    expect((await current({ cookie })).streak).toBe(0);
  });

  it("a logged-in user's calls are keyed to the user, not a cookie", async () => {
    const user = await createTestUser(pool, { email: "qc-user@test.com" });
    const token = app.jwt.sign({ sub: user.id, role: "USER" }, { expiresIn: 3600 });
    const res = await app.inject({
      method: "POST",
      url: "/v1/quick-call",
      headers: { authorization: `Bearer ${token}` },
      payload: { direction: "UP" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === ANON_COOKIE_NAME)).toBeUndefined();
    const state = await current({ authorization: `Bearer ${token}` });
    expect(state.call).not.toBeNull();
  });
});
