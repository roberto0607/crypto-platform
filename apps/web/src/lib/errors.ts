import { AxiosError } from "axios";
import type { LegacyApiError, V1ApiError } from "@/types/api";

/** Extract error code from either envelope style */
export function normalizeApiError(
  error: AxiosError<LegacyApiError | V1ApiError>,
): { code: string; message: string } {
  const data = error.response?.data;
  if (!data) {
    return { code: "network_error", message: "Network error — please try again" };
  }

  // V1 envelope: { code, message, requestId }
  if ("code" in data && typeof data.code === "string") {
    const v1 = data as V1ApiError;
    return {
      code: v1.code,
      message: ERROR_MESSAGES[v1.code] ?? v1.message,
    };
  }

  // Legacy envelope: { ok: false, error }
  if ("error" in data && typeof data.error === "string") {
    const legacy = data as LegacyApiError;
    return {
      code: legacy.error,
      message: ERROR_MESSAGES[legacy.error] ?? legacy.error,
    };
  }

  return { code: "unknown", message: "An unexpected error occurred" };
}

/** Human-readable messages for all backend error codes */
export const ERROR_MESSAGES: Record<string, string> = {
  // 400
  invalid_input: "Invalid input — please check your data and try again",
  insufficient_balance: "Insufficient balance for this operation",
  no_price_available: "No price available for this pair right now",
  order_not_cancelable: "This order can no longer be cancelled",
  insufficient_liquidity: "Not enough liquidity to fill this order",
  trigger_not_cancelable: "This trigger order can no longer be cancelled",
  invite_required: "An invite code is required to register",
  invite_invalid: "This invite code is invalid or expired",

  // 401
  invalid_credentials: "Invalid email or password",
  unauthorized: "You must be logged in to do this",

  // 403
  forbidden: "You do not have permission for this action",
  governance_check_failed: "Governance check failed",
  account_quarantined: "Your account has been temporarily restricted",
  user_trading_disabled: "Trading is disabled for your account",
  insufficient_scope: "Your API key does not have the required scope",

  // 404
  user_not_found: "User not found",
  asset_not_found: "Asset not found",
  wallet_not_found: "Wallet not found",
  order_not_found: "Order not found",
  pair_not_found: "Trading pair not found",
  replay_not_found: "Replay session not found",
  trigger_not_found: "Trigger order not found",
  run_not_found: "Strategy run not found",
  api_key_not_found: "API key not found",
  replay_not_active: "No active replay session",
  replay_already_stopped: "Replay session is already stopped",
  run_not_running: "Strategy run is not currently running",
  run_not_paused: "Strategy run is not paused",
  run_not_active: "Strategy run is not active",
  no_active_replay: "No active replay session found",
  incident_not_found: "Incident not found",

  // 409
  email_taken: "This email address is already registered",
  wallet_already_exists: "You already have a wallet for this asset",
  asset_already_exists: "An asset with this symbol already exists",
  pair_already_exists: "This trading pair already exists",
  role_unchanged: "User already has this role",

  // 429 / abuse
  risk_check_failed: "Risk check failed — trading temporarily restricted",
  repair_has_high_findings: "Repair blocked due to high-severity findings",
  no_recon_data: "No reconciliation data available",
  unquarantine_not_allowed: "Cannot remove quarantine at this time",
  quota_exceeded: "Rate limit exceeded — please slow down",
  suspicious_activity: "Suspicious activity detected on your account",
  login_blocked: "Too many failed login attempts — try again later",
  api_key_rate_limit: "API key rate limit exceeded",

  // 500
  server_error: "Internal server error — please try again later",

  // 503
  pair_queue_overloaded: "Trading engine is overloaded — try again shortly",
  queue_timeout: "Request timed out — please try again",
  server_shutting_down: "Server is restarting — please retry in a moment",
  system_overloaded: "System is under heavy load — please try again",
  trading_paused_global: "Trading is temporarily paused system-wide",
  trading_paused_pair: "Trading is temporarily paused for this pair",
  read_only_mode: "System is in read-only mode — trading is disabled",
};

/** Whether the HTTP status indicates a retryable error */
export function isRetryable(status: number): boolean {
  return status === 503 || status === 429;
}
