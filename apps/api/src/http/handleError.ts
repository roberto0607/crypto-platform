/**
 * Shared error handler for route catch blocks.
 *
 * - If `err` is an AppError or a plain Error with a known code, sends the
 *   standard `{ ok: false, error: "<code>" }` JSON response.
 * - Otherwise re-throws so Fastify's default handler deals with it.
 *
 * Usage in a catch block:
 *   } catch (err) {
 *     return handleError(reply, err);
 *   }
 */

import type { FastifyReply } from "fastify";
import { AppError, toAppError } from "../errors/AppError";

export function handleError(reply: FastifyReply, err: unknown): void {
  const appErr = toAppError(err);
  if (appErr) {
    const body: Record<string, unknown> = { ok: false, error: appErr.code };
    if (appErr.details !== undefined) body.details = appErr.details;
    reply.code(appErr.statusCode).send(body);
    return;
  }
  throw err;
}
