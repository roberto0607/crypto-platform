/**
 * Centralized error code → HTTP status mapping.
 *
 * AppError is a lightweight Error subclass that carries a machine-readable
 * code and the matching HTTP status.  `toAppError` converts the existing
 * `new Error("error_code")` pattern (used in repos / matching engine) into
 * an AppError so route handlers don't need to maintain their own mapping.
 */

const ERROR_STATUS: Record<string, number> = {
  // 400
  invalid_input: 400,
  insufficient_balance: 400,
  no_price_available: 400,
  order_not_cancelable: 400,
  insufficient_liquidity: 400,
  trigger_not_cancelable: 400,
  invite_required: 400,
  invite_invalid: 400,
  // 401
  invalid_credentials: 401,
  unauthorized: 401,
  // 403
  forbidden: 403,
  governance_check_failed: 403,
  account_quarantined: 403,
  user_trading_disabled: 403,
  insufficient_scope: 403,
  // 404
  user_not_found: 404,
  asset_not_found: 404,
  wallet_not_found: 404,
  order_not_found: 404,
  pair_not_found: 404,
  replay_not_found: 404,
  trigger_not_found: 404,
  run_not_found: 404,
  api_key_not_found: 404,
  // 400 (state errors)
  replay_not_active: 400,
  replay_already_stopped: 400,
  run_not_running: 400,
  run_not_paused: 400,
  run_not_active: 400,
  no_active_replay: 400,
  // 409
  email_taken: 409,
  wallet_already_exists: 409,
  asset_already_exists: 409,
  pair_already_exists: 409,
  role_unchanged: 409,
  risk_check_failed: 409,
  // 409 (repair)
  repair_has_high_findings: 409,
  // 404 (repair)
  no_recon_data: 404,
  // 409 (incidents)
  unquarantine_not_allowed: 409,
  // 404 (incidents)
  incident_not_found: 404,
  // 429
  quota_exceeded: 429,
  suspicious_activity: 429,
  login_blocked: 429,
  api_key_rate_limit: 429,
  // 500
  server_error: 500,
  // 503 — queue backpressure / timeout / shutdown / load shedding / kill switches
  pair_queue_overloaded: 503,
  queue_timeout: 503,
  server_shutting_down: 503,
  system_overloaded: 503,
  trading_paused_global: 503,
  trading_paused_pair: 503,
  read_only_mode: 503,
};

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: string, details?: unknown) {
    super(code);
    this.code = code;
    this.statusCode = ERROR_STATUS[code] ?? 500;
    this.details = details;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/**
 * Convert a plain Error whose `.message` matches a known code into AppError.
 * Returns null for unknown errors (PG errors, network errors, etc.).
 */
export function toAppError(err: unknown): AppError | null {
  if (isAppError(err)) return err;
  if (err instanceof Error && err.message in ERROR_STATUS) {
    return new AppError(err.message);
  }
  return null;
}
