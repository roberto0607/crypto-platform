/**
 * anonTransfer.ts — hand an anonymous visitor's quick-call streak to the
 * account they just signed up or logged in as, then drop the anon session.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { logger as rootLogger } from "../observability/logContext";
import { ANON_COOKIE_NAME, anonCookieOptions, anonIdentity, userIdentity, verifyAnonCookie } from "./identity";
import { transferStreak } from "./quickCallService";

const logger = rootLogger.child({ module: "quickCall" });

/** Best-effort: a failure here is logged and never fails the auth request. */
export async function transferAnonQuickCallState(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): Promise<void> {
  const anonId = verifyAnonCookie(req.cookies[ANON_COOKIE_NAME]);
  if (!anonId) return;
  try {
    await transferStreak(anonIdentity(anonId).key, userIdentity(userId).key);
    reply.clearCookie(ANON_COOKIE_NAME, anonCookieOptions);
  } catch (err) {
    logger.warn({ err, userId }, "quick_call_streak_transfer_failed");
  }
}
