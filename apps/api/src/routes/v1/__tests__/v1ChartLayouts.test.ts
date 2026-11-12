import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../app";
import { pool } from "../../../db/pool";
import { ensureMigrations, resetTestData } from "../../../testing/resetDb";
import { createTestUser } from "../../../testing/fixtures";

const buildOpts = {
    logger: false,
    disableKrakenFeed: true,
    disableTriggerEngine: true,
    disableJobRunner: true,
    disableOutboxWorker: true,
    disableLockSampler: true,
    disableOrchestrator: true,
} as const;

const URL = "/v1/chart-layouts";

function auth(app: FastifyInstance, sub: string) {
    return { authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` };
}

const swingConfig = {
    version: 1,
    indicators: { keyLevels: true, vpvr: true, rsi: true, atr: true, volume: true, adx: true, utBot: true, swings: false },
    params: {
        vpvr: { mode: "visible" }, rsi: { period: 14 }, atr: { period: 14 },
        movingAverages: [
            { id: "ma1", type: "EMA", length: 21, color: "#3b82f6" },
            { id: "ma2", type: "SMA", length: 50, color: "#f59e0b" },
            { id: "ma3", type: "SMA", length: 200, color: "#ef4444" },
            { id: "ma4", type: "SMA", length: 200, color: "#22c55e", timeframe: "1d", forming: true },
            { id: "ma5", type: "SMA", length: 50, color: "#a855f7", timeframe: "1w" },
            { id: "ma6", type: "EMA", length: 9, color: "#06b6d4", timeframe: "chart" },
        ],
        maCross: { fast: "ma2", slow: "ma3" },
        adx: { diLength: 10, adxSmoothing: 20, threshold: 20 },
        utBot: { keyValue: 2.5, atrPeriod: 14 },
    },
    panes: { order: ["rsi", "adx", "atr", "volume"], collapsed: { rsi: false, atr: true, adx: false }, heights: { rsi: 120, adx: 150 } },
    timeframe: "4h",
};

const ma = (over: Record<string, unknown> = {}) => ({ id: "ma1", type: "EMA", length: 20, color: "#3b82f6", ...over });

describe("/v1/chart-layouts", () => {
    let app: FastifyInstance;
    let alice: { id: string };
    let bob: { id: string };

    beforeAll(async () => {
        await ensureMigrations();
        app = await buildApp(buildOpts);
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(async () => {
        await resetTestData();
        alice = await createTestUser(pool, { email: "alice-layouts@test.com" });
        bob = await createTestUser(pool, { email: "bob-layouts@test.com" });
    });

    function create(userId: string, payload: Record<string, unknown>) {
        return app.inject({ method: "POST", url: URL, headers: auth(app, userId), payload });
    }
    function patch(userId: string, id: string, payload: Record<string, unknown>) {
        return app.inject({ method: "PATCH", url: `${URL}/${id}`, headers: auth(app, userId), payload });
    }
    async function list(userId: string) {
        const res = await app.inject({ method: "GET", url: URL, headers: auth(app, userId) });
        expect(res.statusCode).toBe(200);
        return res.json().layouts as Array<{ id: string; name: string; is_default: boolean; config: unknown }>;
    }

    // ── Auth ──────────────────────────────────────────────────────────────
    it("requires auth on every verb", async () => {
        const id = "00000000-0000-0000-0000-000000000000";
        const calls = [
            app.inject({ method: "GET", url: URL }),
            app.inject({ method: "POST", url: URL, payload: { name: "x", config: { version: 1 } } }),
            app.inject({ method: "PATCH", url: `${URL}/${id}`, payload: { name: "y" } }),
            app.inject({ method: "DELETE", url: `${URL}/${id}` }),
        ];
        for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(401);
    });

    // ── CRUD ──────────────────────────────────────────────────────────────
    it("creates, lists, updates and deletes a layout", async () => {
        const created = await create(alice.id, { name: "Swing mine", config: swingConfig });
        expect(created.statusCode).toBe(201);
        const layout = created.json().layout;
        expect(layout.name).toBe("Swing mine");
        expect(layout.config).toEqual(swingConfig);
        expect(layout.is_default).toBe(false);
        expect(layout.user_id).toBeUndefined();

        expect((await list(alice.id)).map((l) => l.name)).toEqual(["Swing mine"]);

        const renamed = await patch(alice.id, layout.id, { name: "Swing v2" });
        expect(renamed.statusCode).toBe(200);
        expect(renamed.json().layout.name).toBe("Swing v2");

        const newConfig = { version: 1, indicators: { rsi: true } };
        const updated = await patch(alice.id, layout.id, { config: newConfig });
        expect(updated.statusCode).toBe(200);
        expect(updated.json().layout.config).toEqual(newConfig);
        expect(updated.json().layout.name).toBe("Swing v2");

        const del = await app.inject({ method: "DELETE", url: `${URL}/${layout.id}`, headers: auth(app, alice.id) });
        expect(del.statusCode).toBe(204);
        expect(await list(alice.id)).toEqual([]);

        const again = await app.inject({ method: "DELETE", url: `${URL}/${layout.id}`, headers: auth(app, alice.id) });
        expect(again.statusCode).toBe(404);
    });

    it("trims the name and rejects a duplicate name (on create and on rename) with 409", async () => {
        expect((await create(alice.id, { name: "  A  ", config: { version: 1 } })).json().layout.name).toBe("A");
        const dup = await create(alice.id, { name: "A", config: { version: 1 } });
        expect(dup.statusCode).toBe(409);
        expect(dup.json().code).toBe("chart_layout_name_taken");

        const b = (await create(alice.id, { name: "B", config: { version: 1 } })).json().layout;
        const clash = await patch(alice.id, b.id, { name: "A" });
        expect(clash.statusCode).toBe(409);

        // Names are per user: bob may also have "A".
        expect((await create(bob.id, { name: "A", config: { version: 1 } })).statusCode).toBe(201);
    });

    // ── Ownership ─────────────────────────────────────────────────────────
    it("a user can't see, update, default or delete another user's layout", async () => {
        const mine = (await create(alice.id, { name: "Alice", config: swingConfig })).json().layout;

        expect(await list(bob.id)).toEqual([]);

        for (const body of [{ name: "hijack" }, { config: { version: 1 } }, { isDefault: true }]) {
            const res = await patch(bob.id, mine.id, body);
            expect(res.statusCode).toBe(404);
            expect(res.json().code).toBe("chart_layout_not_found");
        }
        const del = await app.inject({ method: "DELETE", url: `${URL}/${mine.id}`, headers: auth(app, bob.id) });
        expect(del.statusCode).toBe(404);

        const [still] = await list(alice.id);
        expect(still!.name).toBe("Alice");
        expect(still!.config).toEqual(swingConfig);
        expect(still!.is_default).toBe(false);
    });

    // ── Validation ────────────────────────────────────────────────────────
    const badConfigs: Array<[string, unknown]> = [
        ["unknown indicator id", { version: 1, indicators: { ema21: true } }],
        ["non-boolean toggle", { version: 1, indicators: { rsi: "yes" } }],
        ["unknown top-level config key", { version: 1, drawings: [] }],
        ["missing version", { indicators: { rsi: true } }],
        ["wrong version", { version: 2 }],
        ["unknown param group", { version: 1, params: { sma: { length: 50 } } }],
        ["unknown param key", { version: 1, params: { rsi: { period: 14, source: "close" } } }],
        ["param value not allowed", { version: 1, params: { rsi: { period: 21 } } }],
        ["bad vpvr mode", { version: 1, params: { vpvr: { mode: "monthly" } } }],
        ["unknown MA type", { version: 1, params: { movingAverages: [ma({ type: "WMA" })] } }],
        ["MA length 0", { version: 1, params: { movingAverages: [ma({ length: 0 })] } }],
        ["MA length over 500", { version: 1, params: { movingAverages: [ma({ length: 501 })] } }],
        ["fractional MA length", { version: 1, params: { movingAverages: [ma({ length: 20.5 })] } }],
        ["bad MA color", { version: 1, params: { movingAverages: [ma({ color: "red" })] } }],
        ["bad MA id", { version: 1, params: { movingAverages: [ma({ id: "MA 1" })] } }],
        ["bad MA timeframe", { version: 1, params: { movingAverages: [ma({ timeframe: "2h" })] } }],
        ["MA timeframe not a string", { version: 1, params: { movingAverages: [ma({ timeframe: 86400 })] } }],
        ["MA forming not boolean", { version: 1, params: { movingAverages: [ma({ timeframe: "1d", forming: "yes" })] } }],
        ["unknown MA key", { version: 1, params: { movingAverages: [{ ...ma(), source: "close" }] } }],
        ["duplicate MA id", { version: 1, params: { movingAverages: [ma(), ma({ length: 50 })] } }],
        ["more than 10 MAs", { version: 1, params: { movingAverages: Array.from({ length: 11 }, (_, i) => ma({ id: `m${i}` })) } }],
        ["cross on an unknown MA", { version: 1, params: { movingAverages: [ma()], maCross: { fast: "ma1", slow: "nope" } } }],
        ["cross on the same MA", { version: 1, params: { movingAverages: [ma()], maCross: { fast: "ma1", slow: "ma1" } } }],
        ["ADX length 0", { version: 1, params: { adx: { diLength: 0, adxSmoothing: 14, threshold: 25 } } }],
        ["ADX fractional length", { version: 1, params: { adx: { diLength: 14.5, adxSmoothing: 14, threshold: 25 } } }],
        ["ADX threshold 100", { version: 1, params: { adx: { diLength: 14, adxSmoothing: 14, threshold: 100 } } }],
        ["ADX missing a key", { version: 1, params: { adx: { diLength: 14, adxSmoothing: 14 } } }],
        ["ADX unknown key", { version: 1, params: { adx: { diLength: 14, adxSmoothing: 14, threshold: 25, source: "close" } } }],
        ["UT Bot key value 0", { version: 1, params: { utBot: { keyValue: 0, atrPeriod: 10 } } }],
        ["UT Bot key value off the 0.1 step", { version: 1, params: { utBot: { keyValue: 1.25, atrPeriod: 10 } } }],
        ["UT Bot key value over 20", { version: 1, params: { utBot: { keyValue: 20.1, atrPeriod: 10 } } }],
        ["UT Bot ATR period string", { version: 1, params: { utBot: { keyValue: 1, atrPeriod: "10" } } }],
        ["cross without MAs", { version: 1, params: { maCross: { fast: "a", slow: "b" } } }],
        ["unknown pane", { version: 1, panes: { order: ["rsi", "stoch"] } }],
        ["duplicate pane in order", { version: 1, panes: { order: ["rsi", "rsi"] } }],
        ["pane height too small", { version: 1, panes: { heights: { rsi: 10 } } }],
        ["pane height too large", { version: 1, panes: { heights: { rsi: 5000 } } }],
        ["pane height not a number", { version: 1, panes: { heights: { rsi: "80" } } }],
        ["collapsed not boolean", { version: 1, panes: { collapsed: { rsi: 1 } } }],
        ["unknown panes key", { version: 1, panes: { widths: {} } }],
        ["bad timeframe", { version: 1, timeframe: "2h" }],
        ["config not an object", "everything"],
        ["config an array", [1, 2]],
    ];
    for (const [label, config] of badConfigs) {
        it(`rejects config with ${label} (400)`, async () => {
            const res = await create(alice.id, { name: "Bad", config });
            expect(res.statusCode).toBe(400);
            expect(res.json().code).toBe("invalid_input");
            expect(await list(alice.id)).toEqual([]);
        });
    }

    // ── Old EMA toggles (a tab still running the pre-list build) ──────────
    it("converts the old ema20/50/200 toggles into the same EMA lines on create and PATCH", async () => {
        const old = {
            version: 1,
            indicators: { ema20: true, ema50: true, ema200: true, rsi: true },
            params: { rsi: { period: 14 } },
        };
        const expected = {
            version: 1,
            indicators: { rsi: true },
            params: {
                rsi: { period: 14 },
                movingAverages: [
                    { id: "ema20", type: "EMA", length: 20, color: "#3b82f6" },
                    { id: "ema50", type: "EMA", length: 50, color: "#f59e0b" },
                    { id: "ema200", type: "EMA", length: 200, color: "#ef4444" },
                ],
                maCross: { fast: "ema50", slow: "ema200" },
            },
        };
        const created = await create(alice.id, { name: "Old tab", config: old });
        expect(created.statusCode).toBe(201);
        expect(created.json().layout.config).toEqual(expected);

        const l = created.json().layout;
        const res = await patch(alice.id, l.id, { config: { version: 1, indicators: { ema20: true, ema200: false } } });
        expect(res.statusCode).toBe(200);
        expect(res.json().layout.config).toEqual({
            version: 1,
            indicators: {},
            params: { movingAverages: [{ id: "ema20", type: "EMA", length: 20, color: "#3b82f6" }] },
        });
        expect((await list(alice.id))[0]!.config).toEqual(res.json().layout.config);
    });

    it("rejects the same bad config on PATCH", async () => {
        const l = (await create(alice.id, { name: "Ok", config: { version: 1 } })).json().layout;
        const res = await patch(alice.id, l.id, { config: { version: 1, indicators: { ema21: true } } });
        expect(res.statusCode).toBe(400);
    });

    it("rejects a config over 16 KB", async () => {
        // A strictly valid config is far under 16 KB (~1 KB with everything set), so
        // the cap is a backstop checked BEFORE the shape: an oversized body is
        // rejected as too large without being walked.
        const big = { version: 1, indicators: { rsi: true }, timeframe: "1h", pad: "x".repeat(17_000) };
        const res = await create(alice.id, { name: "Big", config: big });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe("invalid_input");
        expect(res.json().details).toMatchObject({ reason: "config_too_large" });
    });

    it("rejects bad names and unknown body keys", async () => {
        for (const payload of [
            { name: "", config: { version: 1 } },
            { name: "   ", config: { version: 1 } },
            { name: "x".repeat(41), config: { version: 1 } },
            { config: { version: 1 } },
            { name: "no config" },
            { name: "extra", config: { version: 1 }, owner: bob.id },
            { name: "extra", config: { version: 1 }, userId: bob.id },
        ]) {
            const res = await create(alice.id, payload);
            expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        }
        const l = (await create(alice.id, { name: "Ok", config: { version: 1 } })).json().layout;
        expect((await patch(alice.id, l.id, {})).statusCode).toBe(400);
        expect((await patch(alice.id, l.id, { userId: bob.id })).statusCode).toBe(400);
        expect((await patch(alice.id, l.id, { isDefault: "yes" })).statusCode).toBe(400);
        const badId = await app.inject({ method: "PATCH", url: `${URL}/not-a-uuid`, headers: auth(app, alice.id), payload: { name: "z" } });
        expect(badId.statusCode).toBe(400);
    });

    // ── Default uniqueness ────────────────────────────────────────────────
    it("keeps at most one default per user", async () => {
        const a = (await create(alice.id, { name: "A", config: { version: 1 }, isDefault: true })).json().layout;
        expect(a.is_default).toBe(true);
        const b = (await create(alice.id, { name: "B", config: { version: 1 }, isDefault: true })).json().layout;
        expect(b.is_default).toBe(true);
        let rows = await list(alice.id);
        expect(rows.filter((r) => r.is_default).map((r) => r.name)).toEqual(["B"]);

        // Moving the default back via PATCH.
        expect((await patch(alice.id, a.id, { isDefault: true })).json().layout.is_default).toBe(true);
        rows = await list(alice.id);
        expect(rows.filter((r) => r.is_default).map((r) => r.name)).toEqual(["A"]);

        // Clearing it.
        expect((await patch(alice.id, a.id, { isDefault: false })).json().layout.is_default).toBe(false);
        expect((await list(alice.id)).some((r) => r.is_default)).toBe(false);

        // Bob's default is independent of Alice's.
        await patch(alice.id, a.id, { isDefault: true });
        await create(bob.id, { name: "Bob", config: { version: 1 }, isDefault: true });
        expect((await list(alice.id)).filter((r) => r.is_default)).toHaveLength(1);
        expect((await list(bob.id)).filter((r) => r.is_default)).toHaveLength(1);
    });

    it("the partial unique index rejects a second default written directly", async () => {
        await create(alice.id, { name: "A", config: { version: 1 }, isDefault: true });
        await expect(
            pool.query(
                `INSERT INTO chart_layouts (user_id, name, config, is_default) VALUES ($1, 'B', '{"version":1}', true)`,
                [alice.id],
            ),
        ).rejects.toMatchObject({ code: "23505" });
    });

    it("concurrent set-default calls leave exactly one default", async () => {
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) ids.push((await create(alice.id, { name: `L${i}`, config: { version: 1 } })).json().layout.id);
        const results = await Promise.all(ids.map((id) => patch(alice.id, id, { isDefault: true })));
        for (const r of results) expect(r.statusCode).toBe(200);
        expect((await list(alice.id)).filter((r) => r.is_default)).toHaveLength(1);
    });

    // ── 20 cap ────────────────────────────────────────────────────────────
    it("caps a user at 20 layouts", async () => {
        for (let i = 0; i < 20; i++) {
            expect((await create(alice.id, { name: `L${i}`, config: { version: 1 } })).statusCode).toBe(201);
        }
        const over = await create(alice.id, { name: "L20", config: { version: 1 } });
        expect(over.statusCode).toBe(400);
        expect(over.json().code).toBe("chart_layout_limit_exceeded");

        // The cap is per user.
        expect((await create(bob.id, { name: "L0", config: { version: 1 } })).statusCode).toBe(201);

        // Deleting frees a slot.
        const first = (await list(alice.id))[0]!;
        await app.inject({ method: "DELETE", url: `${URL}/${first.id}`, headers: auth(app, alice.id) });
        expect((await create(alice.id, { name: "L20", config: { version: 1 } })).statusCode).toBe(201);
    });

    it("holds the cap under concurrent creates", async () => {
        for (let i = 0; i < 18; i++) await create(alice.id, { name: `L${i}`, config: { version: 1 } });
        const results = await Promise.all(
            Array.from({ length: 6 }, (_, i) => create(alice.id, { name: `C${i}`, config: { version: 1 } })),
        );
        expect(results.filter((r) => r.statusCode === 201)).toHaveLength(2);
        expect(results.filter((r) => r.statusCode === 400)).toHaveLength(4);
        expect(await list(alice.id)).toHaveLength(20);
    });
});
