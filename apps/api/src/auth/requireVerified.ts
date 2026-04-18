import type { FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config.js";
import { pool } from "../db/pool.js";

export async function requireVerified(req: FastifyRequest, reply: FastifyReply) {
  if (!config.requireEmailVerification) return;  // Feature flag off
  if (!req.user?.id) return;  // Not authenticated (handled by requireUser)

  const { rows } = await pool.query(
    "SELECT email_verified_at FROM users WHERE id = $1",
    [req.user.id]
  );

  // If the user row is missing, the session points at a deleted/unknown user.
  // Treat as unauthenticated rather than silently allowing the request.
  if (rows.length === 0) {
    return reply.code(401).send({
      ok: false,
      error: "unauthorized",
    });
  }

  if (!rows[0].email_verified_at) {
    return reply.code(403).send({
      ok: false,
      error: "email_not_verified",
      message: "Please verify your email address before accessing this resource.",
    });
  }
}
