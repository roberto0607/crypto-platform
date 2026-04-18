import { pool } from "../db/pool";
import { config } from "../config";
import { loginBlockedTotal } from "../metrics";

/**
 * Record a login attempt (success or failure).
 */
export async function recordLoginAttempt(params: {
  emailNormalized: string;
  ipAddress: string;
  success: boolean;
}): Promise<void> {
  await pool.query(
    `INSERT INTO login_attempts (email_normalized, ip_address, success)
     VALUES ($1, $2, $3)`,
    [params.emailNormalized, params.ipAddress, params.success],
  );
}

/**
 * Check whether login should be blocked for this email or IP.
 * Counts failures since last success within the configured window.
 * Returns true if blocked.
 */
export async function isLoginBlocked(params: {
  emailNormalized: string;
  ipAddress: string;
}): Promise<boolean> {
  const windowMinutes = config.loginBlockWindowMinutes;

  // Count failures per email since last success (within window)
  const emailResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM login_attempts
     WHERE email_normalized = $1
       AND success = false
       AND created_at > now() - make_interval(mins := $2)
       AND created_at > COALESCE(
         (SELECT MAX(created_at) FROM login_attempts
          WHERE email_normalized = $1 AND success = true
          AND created_at > now() - make_interval(mins := $2)),
         '1970-01-01'::timestamptz
       )`,
    [params.emailNormalized, windowMinutes],
  );
  const emailParsed = parseInt(emailResult.rows?.[0]?.count ?? "0", 10);
  const emailFailures = Number.isNaN(emailParsed) ? 0 : emailParsed;
  if (emailFailures >= config.maxLoginAttemptsPerEmail) {
    loginBlockedTotal.inc();
    return true;
  }

  // Count failures per IP since last success (within window)
  const ipResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM login_attempts
     WHERE ip_address = $1
       AND success = false
       AND created_at > now() - make_interval(mins := $2)
       AND created_at > COALESCE(
         (SELECT MAX(created_at) FROM login_attempts
          WHERE ip_address = $1 AND success = true
          AND created_at > now() - make_interval(mins := $2)),
         '1970-01-01'::timestamptz
       )`,
    [params.ipAddress, windowMinutes],
  );
  const ipParsed = parseInt(ipResult.rows?.[0]?.count ?? "0", 10);
  const ipFailures = Number.isNaN(ipParsed) ? 0 : ipParsed;
  if (ipFailures >= config.maxLoginAttemptsPerIp) {
    loginBlockedTotal.inc();
    return true;
  }

  return false;
}
