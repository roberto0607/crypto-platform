/**
 * Migration 103 against a database shaped like prod before it: applied on a
 * scratch database that stops at 102, seeded with every kind of name the old
 * schema allowed, then migrated.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { resolveTestDatabaseUrl } from "../../testing/testDbUrl";
import { RESERVED_USERNAMES } from "../../auth/username";

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");
const MIGRATION = "103_usernames.sql";
const DEFAULT_NAME = /^trader_[0-9a-f]{10}$/;

const baseUrl = new URL(resolveTestDatabaseUrl());
const scratchName = `${baseUrl.pathname.slice(1).replace(/_test$/, "")}_mig103_test`;

function urlFor(db: string): string {
    const url = new URL(baseUrl);
    url.pathname = `/${db}`;
    return url.toString();
}

async function withAdmin(run: (admin: Client) => Promise<void>): Promise<void> {
    const admin = new Client({ connectionString: urlFor("postgres") });
    await admin.connect();
    try {
        await run(admin);
    } finally {
        await admin.end();
    }
}

describe("migration 103: usernames", () => {
    let db: Client;

    /** `at` orders signups, so the oldest-keeps-the-name rule can be asserted. */
    async function seed(email: string, name: string | null, at: string): Promise<void> {
        await db.query(
            `INSERT INTO users (email, email_normalized, password_hash, display_name, created_at)
             VALUES ($1, $1, 'x', $2, $3)`,
            [email, name, at],
        );
    }

    async function row(email: string) {
        const { rows } = await db.query<{ display_name: string; username_chosen_at: Date | null }>(
            `SELECT display_name, username_chosen_at FROM users WHERE email_normalized = $1`,
            [email],
        );
        return rows[0]!;
    }

    beforeAll(async () => {
        await withAdmin(async (admin) => {
            await admin.query(`DROP DATABASE IF EXISTS "${scratchName}"`);
            await admin.query(`CREATE DATABASE "${scratchName}"`);
        });
        db = new Client({ connectionString: urlFor(scratchName) });
        await db.connect();

        const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
        for (const file of files.filter((f) => f < MIGRATION)) {
            await db.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
        }

        // Null and empty names
        await seed("secretperson@gmail.com", null, "2026-01-01");
        await seed("empty@test.com", "", "2026-01-01");
        // Names that clash by case, not in signup order of the alphabet
        await seed("clash-newest@test.com", "alice", "2026-03-01");
        await seed("clash-oldest@test.com", "Alice", "2026-01-01");
        await seed("clash-middle@test.com", "ALICE", "2026-02-01");
        // Invalid names
        await seed("spaces@test.com", "has space", "2026-01-01");
        await seed("short@test.com", "ab", "2026-01-01");
        await seed("long@test.com", "a".repeat(31), "2026-01-01");
        await seed("symbol@test.com", "bad-name!", "2026-01-01");
        await seed("unicode@test.com", "ñandú", "2026-01-01");
        await seed("newline@test.com", "good\n", "2026-01-01");
        // Reserved names, in the case a user could have typed them
        await seed("res-admin@test.com", "Admin", "2026-01-01");
        await seed("res-bot@test.com", "market_maker", "2026-01-01");
        for (const name of RESERVED_USERNAMES) {
            await seed(`reserved-${name}@test.com`, name, "2026-01-01");
        }
        // A valid name, and a system user that isn't one of the two bots
        await seed("valid@test.com", "good_Name_1", "2026-01-01");
        await seed("other@system.local", null, "2026-01-01");

        await db.query(fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), "utf8"));
    }, 120_000);

    afterAll(async () => {
        await db?.end();
        await withAdmin(async (admin) => {
            await admin.query(`DROP DATABASE IF EXISTS "${scratchName}"`);
        });
    });

    it("keeps a valid name, exact case, and records it as chosen", async () => {
        const user = await row("valid@test.com");
        expect(user.display_name).toBe("good_Name_1");
        expect(user.username_chosen_at).not.toBeNull();
    });

    it("gives null and empty names a default that says nothing about the email", async () => {
        for (const email of ["secretperson@gmail.com", "empty@test.com"]) {
            const user = await row(email);
            expect(user.display_name).toMatch(DEFAULT_NAME);
            expect(user.username_chosen_at).toBeNull();
        }
        expect((await row("secretperson@gmail.com")).display_name).not.toContain("secretperson");
    });

    it("lets the oldest account keep a name that clashes by case", async () => {
        expect((await row("clash-oldest@test.com")).display_name).toBe("Alice");
        expect((await row("clash-oldest@test.com")).username_chosen_at).not.toBeNull();
        for (const email of ["clash-middle@test.com", "clash-newest@test.com"]) {
            const user = await row(email);
            expect(user.display_name).toMatch(DEFAULT_NAME);
            expect(user.username_chosen_at).toBeNull();
        }
    });

    it("replaces invalid names", async () => {
        for (const email of ["spaces", "short", "long", "symbol", "unicode", "newline"]) {
            const user = await row(`${email}@test.com`);
            expect(user.display_name).toMatch(DEFAULT_NAME);
            expect(user.username_chosen_at).toBeNull();
        }
    });

    it("replaces every reserved name, whatever its case (the SQL list matches the app's)", async () => {
        expect((await row("res-admin@test.com")).display_name).toMatch(DEFAULT_NAME);
        expect((await row("res-bot@test.com")).display_name).toMatch(DEFAULT_NAME);
        for (const name of RESERVED_USERNAMES) {
            expect((await row(`reserved-${name}@test.com`)).display_name).toMatch(DEFAULT_NAME);
        }
    });

    it("renames the two bots to valid names and never prompts them", async () => {
        const mm = await row("mmbot@system.local");
        const risk = await row("riskagent@system.local");
        expect(mm.display_name).toBe("market_maker");
        expect(risk.display_name).toBe("risk_agent");
        expect(mm.username_chosen_at).not.toBeNull();
        expect(risk.username_chosen_at).not.toBeNull();
    });

    it("leaves every row valid and unique", async () => {
        const { rows } = await db.query<{ total: string; distinct_names: string; bad: string }>(
            `SELECT count(*) AS total,
                    count(DISTINCT lower(display_name)) AS distinct_names,
                    count(*) FILTER (WHERE display_name IS NULL OR display_name !~ '^[A-Za-z0-9_]{3,30}$') AS bad
             FROM users`,
        );
        expect(rows[0]!.bad).toBe("0");
        expect(rows[0]!.distinct_names).toBe(rows[0]!.total);
    });

    it("gives a plain insert the default name", async () => {
        await db.query(
            `INSERT INTO users (email, email_normalized, password_hash) VALUES ('new@test.com', 'new@test.com', 'x')`,
        );
        const user = await row("new@test.com");
        expect(user.display_name).toMatch(DEFAULT_NAME);
        expect(user.username_chosen_at).toBeNull();
    });

    it("rejects a case-insensitive duplicate, an invalid name and a null name", async () => {
        const insert = (email: string, name: string | null) =>
            db.query(
                `INSERT INTO users (email, email_normalized, password_hash, display_name) VALUES ($1, $1, 'x', $2)`,
                [email, name],
            );
        await expect(insert("dup@test.com", "ALICE")).rejects.toMatchObject({
            code: "23505",
            constraint: "users_display_name_lower_uq",
        });
        await expect(insert("bad@test.com", "not valid")).rejects.toMatchObject({ code: "23514" });
        await expect(insert("nul@test.com", null)).rejects.toMatchObject({ code: "23502" });
    });
});
