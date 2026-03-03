/**
 * V1 error envelope formatter.
 *
 * Maps AppError (and unknown errors) into the standard v1 envelope:
 *   { code, message, details?, requestId }
 *
 * Used exclusively by /v1 route handlers.
 * Legacy routes continue to use http/handleError.ts unchanged.
 */

import type { FastifyReply } from "fastify";
import { toAppError } from "../errors/AppError";

/** Human-readable messages for known error codes. */
const ERROR_MESSAGES: Record<string, string> = {
  // 400
  invalid_input: "The request input is invalid.",
  insufficient_balance: "Insufficient wallet balance.",
  no_price_available: "No market price is currently available.",
  order_not_cancelable: "This order cannot be canceled.",
  insufficient_liquidity: "Market liquidity insufficient for requested size.",
  trigger_not_cancelable: "This trigger order cannot be canceled.",
  // 401
  invalid_credentials: "Invalid email or password.",
  unauthorized: "Authentication is required.",
  // 403
  forbidden: "You do not have permission to access this resource.",
  // 404 (repair)
  no_recon_data: "No reconciliation data found for this user.",
  // 409 (repair)
  repair_has_high_findings: "Cannot unquarantine: reconciliation has HIGH findings for this user.",
  account_quarantined: "Account quarantined due to reconciliation mismatch.",
  unquarantine_not_allowed: "Cannot unquarantine: incident gating requirements not met.",
  incident_not_found: "The requested incident was not found.",
  // 404
  user_not_found: "The requested user was not found.",
  asset_not_found: "The requested asset was not found.",
  wallet_not_found: "The requested wallet was not found.",
  order_not_found: "The requested order was not found.",
  pair_not_found: "The requested trading pair was not found.",
  replay_not_found: "The requested replay was not found.",
  trigger_not_found: "The requested trigger order was not found.",
  // 409
  email_taken: "This email address is already registered.",
  wallet_already_exists: "A wallet for this asset already exists.",
  asset_already_exists: "An asset with this symbol already exists.",
  pair_already_exists: "This trading pair already exists.",
  role_unchanged: "The user already has the requested role.",
  risk_check_failed: "The order was rejected by risk controls.",
  governance_check_failed: "The order was rejected by account governance controls.",
  // misc 400
  replay_not_active: "The replay session is not active.",
  replay_already_stopped: "The replay session has already stopped.",
  // 503
  system_overloaded: "System under high load. Please retry shortly.",
};

/**
 * Send a v1 error envelope and log structured context.
 *
 * Usage in a /v1 route catch block:
 *   } catch (err) {
 *     return v1HandleError(reply, err);
 *   }
 */
export function v1HandleError(reply: FastifyReply, err: unknown): void {
  const appErr = toAppError(err);
  if (appErr) {
    const req = reply.request;
    req.log.warn(
      {
        errCode: appErr.code,
        statusCode: appErr.statusCode,
        reqId: req.id,
        method: req.method,
        url: req.url,
      },
      `v1_error: ${appErr.code}`,
    );

    const body: Record<string, unknown> = {
      code: appErr.code,
      message: ERROR_MESSAGES[appErr.code] ?? appErr.code,
      requestId: req.id,
    };
    if (appErr.details !== undefined) body.details = appErr.details;

    reply.code(appErr.statusCode).send(body);
    return;
  }

  // Unknown / unexpected error — do not leak internals
  const req = reply.request;
  req.log.error({ err, reqId: req.id }, "v1_unhandled_error");
  reply.code(500).send({
    code: "server_error",
    message: "An unexpected error occurred.",
    requestId: req.id,
  });
}
