import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { pool } from "../../db/pool";
import { logger } from "../../observability/logContext";

// Verifies the resend-verification handler's fire-and-forget .catch() path
// actually fires and logs — not assumed, exercised. sendEmail() is mocked
// to reject with a generic network-shaped error (Error + code: "ETIMEDOUT")
// standing in for any async sendEmail() failure — the exact error type
// doesn't matter here, only that the handler's catch actually fires and
// logs whatever it rejects with. (Originally written to reproduce a real
// nodemailer/SMTP hang; emailTransport.ts has since moved to SendGrid's
// HTTP API — see git history for that investigation — but the wiring this
// test covers is transport-agnostic.)
vi.mock("../../email/emailTransport", () => ({
  sendEmail: vi.fn(),
}));

import { sendEmail } from "../../email/emailTransport";
import { buildApp } from "../../app";

const buildOpts = {
  logger: false,
  disableKrakenFeed: true,
  disableTriggerEngine: true,
  disableAlertEngine: true,
  disableJobRunner: true,
  disableOutboxWorker: true,
  disableLockSampler: true,
  disableOrchestrator: true,
} as const;

describe("POST /auth/resend-verification — sendEmail() rejection is caught and logged", () => {
  let app: FastifyInstance;
  let userId: string;
  const email = `resend-verify-fail-${Date.now()}@example.com`;

  beforeEach(async () => {
    app = await buildApp(buildOpts);
    await app.ready();

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, email_normalized, password_hash)
       VALUES ($1, $1, 'x') RETURNING id`,
      [email],
    );
    userId = rows[0].id;

    vi.mocked(sendEmail).mockReset();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    await app.close();
    vi.restoreAllMocks();
  });

  function bearer(sub: string): Record<string, string> {
    return { authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` };
  }

  it("logs 'Failed to resend verification email' with the timeout error once sendEmail() rejects", async () => {
    const timeoutErr = Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" });
    vi.mocked(sendEmail).mockRejectedValue(timeoutErr);

    const errorSpy = vi.spyOn(logger, "error");

    const res = await app.inject({
      method: "POST",
      url: "/auth/resend-verification",
      headers: bearer(userId),
    });

    // The handler responds before the fire-and-forget send settles —
    // it should NOT block the HTTP response on the email outcome.
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });

    // sendEmail() rejects on the same tick as inject() resolves, but the
    // .catch() callback still runs on a later microtask — wait for it
    // rather than asserting immediately.
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: timeoutErr, userId, to: email }),
        "Failed to resend verification email",
      );
    });
  });
});
