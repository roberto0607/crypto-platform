/**
 * v1Public.test.ts — the public landing stream + handle availability.
 *
 * Integration test against the real *_test Postgres. The featured-match
 * payload is checked for private fields against a match seeded with real
 * emails, user ids, balances (wallets), and match-scoped orders.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import http from "node:http";
import { buildApp } from "../../../app";
import { pool } from "../../../db/pool";
import { ensureMigrations, resetTestData } from "../../../testing/resetDb";
import { createTestUser, createTestAssetAndPair } from "../../../testing/fixtures";
import { createMatch, acceptMatch } from "../../../competitions/matchService";
import { addSpectator } from "../../../competitions/matchSpectatorStore";
import { createEvent } from "../../../events/eventTypes";
import {
  addConnection,
  computeFeaturedMatch,
  recordMatchReturns,
  MAX_CONNECTIONS_PER_IP,
  __onEventForTest,
  __resetLandingForTest,
  type LandingConnection,
} from "../../../landing/landingBroadcaster";
import { recordTrade, __resetLatestTradesForTest } from "../../../quickCall/latestTradeStore";

const buildOpts = {
  logger: false,
  disableKrakenFeed: true,
  disableTriggerEngine: true,
  disableJobRunner: true,
  disableOutboxWorker: true,
  disableLockSampler: true,
  disableOrchestrator: true,
} as const;

/** Every key anywhere in a JSON-able value. */
function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allKeys(v, out);
    }
  }
  return out;
}

function fakeConn(ip: string, identityKey: string | null) {
  const frames: Array<{ event: string; data: unknown }> = [];
  const conn: LandingConnection = { ip, identityKey, send: (event, data) => frames.push({ event, data }) };
  return { conn, frames };
}

describe("Public landing stream", () => {
  let app: FastifyInstance;
  let challenger: { id: string; email: string };
  let opponent: { id: string; email: string };
  let pairId: string;

  beforeAll(async () => {
    await ensureMigrations();
    app = await buildApp(buildOpts);
    await app.ready();
  });

  afterAll(async () => {
    __resetLandingForTest();
    await app.close();
  });

  beforeEach(async () => {
    await resetTestData();
    __resetLandingForTest();
    __resetLatestTradesForTest();
    challenger = await createTestUser(pool, { email: "lp-chal@test.com" });
    opponent = await createTestUser(pool, { email: "lp-opp@test.com" });
    await pool.query(`UPDATE users SET display_name = 'alpha_wolf' WHERE id = $1`, [challenger.id]);
    const { pair } = await createTestAssetAndPair(pool);
    pairId = pair.id;
  });

  async function activeMatch(): Promise<string> {
    const match = await createMatch(challenger.id, opponent.id, 24, [pairId]);
    await acceptMatch(match.id, opponent.id);
    return match.id;
  }

  async function matchOrder(matchId: string, userId: string, side: "BUY" | "SELL", qty: string, minutesAgo: number) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO orders (user_id, pair_id, side, type, qty, qty_filled, status, match_id, updated_at)
       VALUES ($1, $2, $3, 'MARKET', $4, $4, 'FILLED', $5, now() - ($6 || ' minutes')::interval)
       RETURNING id`,
      [userId, pairId, side, qty, matchId, String(minutesAgo)],
    );
    return rows[0]!.id;
  }

  it("featured is null when no match is live", async () => {
    expect(await computeFeaturedMatch()).toBeNull();
  });

  it("builds the featured match with handles, returns, last 3 trades, clock, and spectators", async () => {
    const matchId = await activeMatch();
    await matchOrder(matchId, challenger.id, "BUY", "0.5", 10);
    await matchOrder(matchId, opponent.id, "SELL", "2", 8);
    await matchOrder(matchId, challenger.id, "SELL", "0.25", 5);
    await matchOrder(matchId, opponent.id, "BUY", "1", 1);
    await addSpectator(matchId, "someone");
    recordMatchReturns(matchId, 2.5, -1.25, Date.now());

    const featured = (await computeFeaturedMatch())!;
    expect(featured.matchId).toBe(matchId);
    expect(featured.spectatorCount).toBe(1);
    expect(featured.secondsLeft).toBeGreaterThan(23 * 3600);
    expect(featured.challenger.handle).toBe("alpha_wolf");
    expect(featured.challenger.returnPct).toBe(2.5);
    expect(featured.opponent.returnPct).toBe(-1.25);
    expect(featured.lastTrades.map((t) => [t.player, t.side, t.qty])).toEqual([
      ["opponent", "BUY", "1"],
      ["challenger", "SELL", "0.25"],
      ["opponent", "SELL", "2"],
    ]);
    expect(featured.series).toHaveLength(1);
  });

  it("the featured payload contains no emails, balances, order ids, or user ids", async () => {
    const matchId = await activeMatch();
    const orderIds = [
      await matchOrder(matchId, challenger.id, "BUY", "0.5", 3),
      await matchOrder(matchId, opponent.id, "SELL", "1", 2),
    ];
    recordMatchReturns(matchId, 1, 2, Date.now());

    const featured = await computeFeaturedMatch();
    const json = JSON.stringify(featured);
    const keys = allKeys(featured).map((k) => k.toLowerCase());

    for (const forbidden of ["email", "balance", "orderid", "order_id", "userid", "user_id", "wallet", "password", "challenger_id", "opponent_id", "starting_capital", "startingcapital"]) {
      expect(keys.some((k) => k.includes(forbidden)), `key containing "${forbidden}"`).toBe(false);
    }
    for (const secret of [challenger.email, opponent.email, "lp-chal", "lp-opp", challenger.id, opponent.id, ...orderIds]) {
      expect(json).not.toContain(secret);
    }
  });

  it("a player without a display name gets a null handle, never their email", async () => {
    await activeMatch();
    const featured = (await computeFeaturedMatch())!;
    expect(featured.opponent.handle).toBeNull();
  });

  it("hides returns and $ P&L until a live P&L update has been seen", async () => {
    await activeMatch();
    const featured = (await computeFeaturedMatch())!;
    expect(featured.challenger.returnPct).toBeNull();
    expect(featured.challenger.pnlUsd).toBeNull();
    expect(featured.series).toEqual([]);
  });

  it("routes a quick-call result only to connections holding that identity", () => {
    const mine = fakeConn("1.1.1.1", "anon:me");
    const theirs = fakeConn("2.2.2.2", "anon:them");
    const nobody = fakeConn("3.3.3.3", null);
    const removers = [mine, theirs, nobody].map((f) => addConnection(f.conn)!);
    try {
      __onEventForTest(createEvent("quickcall.settled", {
        id: "c1", direction: "UP", entryPrice: "1", exitPrice: "2", outcome: "WIN", settledAt: 1, streak: 1,
      }, { userId: "anon:me" }));
      const qc = (f: ReturnType<typeof fakeConn>) => f.frames.filter((x) => x.event === "quickcall");
      expect(qc(mine)).toHaveLength(1);
      expect(qc(theirs)).toHaveLength(0);
      expect(qc(nobody)).toHaveLength(0);
    } finally {
      removers.forEach((r) => r());
    }
  });

  it("sends current BTC/ETH/SOL prices on connect, as short symbols", () => {
    recordTrade("BTC/USD", "84000.10");
    recordTrade("SOL/USD", "142.5");
    recordTrade("DOGE/USD", "0.18"); // not tracked
    const f = fakeConn("1.1.1.1", null);
    const remove = addConnection(f.conn)!;
    try {
      expect(f.frames.filter((x) => x.event === "price").map((x) => x.data)).toEqual([
        { symbol: "BTC", price: "84000.10" },
        { symbol: "SOL", price: "142.5" },
      ]);
    } finally {
      remove();
    }
  });

  it("caps concurrent streams per IP", () => {
    const removers = Array.from({ length: MAX_CONNECTIONS_PER_IP }, () => addConnection(fakeConn("9.9.9.9", null).conn));
    expect(removers.every(Boolean)).toBe(true);
    expect(addConnection(fakeConn("9.9.9.9", null).conn)).toBeNull();
    expect(addConnection(fakeConn("8.8.8.8", null).conn)).not.toBeNull();
    removers[0]!();
    expect(addConnection(fakeConn("9.9.9.9", null).conn)).not.toBeNull();
  });

  it("GET /v1/public/landing-stream needs no auth and streams featured: null when idle", async () => {
    // A known price means addConnection writes frames immediately — the
    // headers (with the event-stream content type) must already be out.
    recordTrade("BTC/USD", "84000.10");
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const body = await new Promise<{ status: number; type: string; text: string }>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/v1/public/landing-stream" }, (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk.toString();
          if (text.includes("event: featured")) {
            resolve({ status: res.statusCode!, type: String(res.headers["content-type"]), text });
            req.destroy();
          }
        });
      });
      req.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
      });
      setTimeout(() => reject(new Error("no featured frame within 8s")), 8_000);
    });
    expect(body.status).toBe(200);
    expect(body.type).toContain("text/event-stream");
    expect(body.text.startsWith(": connected\n\n")).toBe(true);
    expect(body.text).toContain('event: price\ndata: {"symbol":"BTC","price":"84000.10"}');
    expect(body.text).toContain("event: featured\ndata: null\n\n");
  });

  describe("handles", () => {
    async function check(h: string) {
      const res = await app.inject({ method: "GET", url: `/v1/handles/available?h=${encodeURIComponent(h)}` });
      expect(res.statusCode).toBe(200);
      return res.json() as { available: boolean; reason?: string };
    }

    it("reports a free, well-formed handle as available", async () => {
      expect(await check("fresh_trader")).toEqual(expect.objectContaining({ available: true }));
    });

    it("reports a taken handle as taken, case-insensitively", async () => {
      expect(await check("ALPHA_WOLF")).toEqual(expect.objectContaining({ available: false, reason: "taken" }));
    });

    it("reports a malformed handle as invalid", async () => {
      expect(await check("no spaces!")).toEqual(expect.objectContaining({ available: false, reason: "invalid" }));
      expect(await check("ab")).toEqual(expect.objectContaining({ available: false, reason: "invalid" }));
    });

    it("register stores the chosen handle", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: "lp-new@test.com", password: "correct-horse-battery", displayName: "new_blood" },
      });
      expect(res.statusCode).toBe(201);
      const { rows } = await pool.query(`SELECT display_name FROM users WHERE id = $1`, [res.json().user.id]);
      expect(rows[0].display_name).toBe("new_blood");
      expect((await check("New_Blood")).available).toBe(false);
    });

    it("register rejects a handle someone already holds (any case) with display_name_taken", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: "lp-dupe@test.com", password: "correct-horse-battery", displayName: "Alpha_Wolf" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("display_name_taken");
    });

    it("register still works without a handle", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: "lp-nohandle@test.com", password: "correct-horse-battery" },
      });
      expect(res.statusCode).toBe(201);
    });
  });
});
