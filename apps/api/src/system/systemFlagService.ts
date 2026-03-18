import { pool } from "../db/pool";

export async function getFlag(key: string): Promise<Record<string, unknown> | null> {
  const result = await pool.query<{ value: Record<string, unknown> }>(
    `SELECT value FROM system_flags WHERE key = $1 LIMIT 1`,
    [key],
  );
  return result.rows[0]?.value ?? null;
}

export async function setFlag(key: string, value: Record<string, unknown>): Promise<void> {
  await pool.query(
    `UPDATE system_flags SET value = $1, updated_at = now() WHERE key = $2`,
    [JSON.stringify(value), key],
  );
}

export async function isGlobalTradingEnabled(): Promise<boolean> {
  const flag = await getFlag("TRADING_ENABLED_GLOBAL");
  if (!flag) return true;
  return flag.enabled !== false;
}

export async function isReadOnlyMode(): Promise<boolean> {
  const flag = await getFlag("READ_ONLY_MODE");
  if (!flag) return false;
  return flag.enabled === true;
}

export async function setPairTradingEnabled(pairId: string, enabled: boolean): Promise<void> {
  await pool.query(
    `UPDATE trading_pairs SET trading_enabled = $1, updated_at = now() WHERE id = $2`,
    [enabled, pairId],
  );
}
