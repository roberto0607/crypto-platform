/**
 * matchWalletsRoute.test.ts — over HTTP: GET /v1/matches/:id/wallets returns
 * the caller's own match wallets (participants only), and GET /wallets stays
 * free-play only while a match is live (migration 095).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { getTestApp, closeTestApp, registerAndLogin, getPool } from "./helpers";
import { fundTestMatchWallets } from "../src/testing/fixtures";

let app: FastifyInstance;
let me: { accessToken: string; userId: string };
let opp: { accessToken: string; userId: string };
let outsider: { accessToken: string; userId: string };
let matchId: string;

const get = (url: string, token: string) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
    app = await getTestApp();
    me = await registerAndLogin(app, "mw-me");
    opp = await registerAndLogin(app, "mw-opp");
    outsider = await registerAndLogin(app, "mw-out");
    const { rows: [m] } = await getPool().query<{ id: string }>(
        `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status, started_at, ends_at)
         VALUES ($1, $2, 24, '50000', 'ACTIVE', now(), now() + interval '1 day') RETURNING id`,
        [me.userId, opp.userId],
    );
    matchId = m!.id;
    await fundTestMatchWallets(getPool(), matchId, [me.userId, opp.userId], "50000");
});

afterAll(async () => {
    const pool = getPool();
    await pool.query(`DELETE FROM ledger_entries WHERE wallet_id IN (SELECT id FROM wallets WHERE match_id = $1)`, [matchId]);
    await pool.query(`DELETE FROM wallets WHERE match_id = $1`, [matchId]);
    await pool.query(`DELETE FROM matches WHERE id = $1`, [matchId]);
    await closeTestApp();
});

describe("GET /v1/matches/:id/wallets", () => {
    it("returns only the caller's own match wallets, USD funded with starting_capital", async () => {
        const res = await get(`/v1/matches/${matchId}/wallets`, me.accessToken);
        expect(res.statusCode).toBe(200);
        const wallets = res.json().wallets as { user_id: string; symbol: string; balance: string; match_id: string; closed_at: string | null }[];
        expect(wallets.length).toBeGreaterThan(0);
        expect(wallets.every((w) => w.user_id === me.userId && w.match_id === matchId && w.closed_at === null)).toBe(true);
        expect(Number(wallets.find((w) => w.symbol === "USD")!.balance)).toBe(50000);
    });

    it("403 for a non-participant, 404 for an unknown match, 400 for a non-uuid", async () => {
        expect((await get(`/v1/matches/${matchId}/wallets`, outsider.accessToken)).statusCode).toBe(403);
        expect((await get(`/v1/matches/${randomUUID()}/wallets`, me.accessToken)).statusCode).toBe(404);
        expect((await get(`/v1/matches/not-a-uuid/wallets`, me.accessToken)).statusCode).toBe(400);
    });
});

describe("GET /wallets during a match", () => {
    it("is free-play only — the match wallets never show up there", async () => {
        const res = await get(`/wallets`, me.accessToken);
        expect(res.statusCode).toBe(200);
        const ids = (res.json().wallets as { id: string }[]).map((w) => w.id);
        const { rows } = await getPool().query<{ id: string }>(`SELECT id FROM wallets WHERE match_id = $1`, [matchId]);
        for (const r of rows) expect(ids).not.toContain(r.id);
    });
});
