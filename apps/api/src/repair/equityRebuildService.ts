import type { PoolClient } from "pg";
import type { RepairMode } from "./repairTypes";

/**
 * Stub — equity snapshots are fill-based (inserted per trade).
 * Full equity rebuild deferred to a future PR.
 */
export async function rebuildEquityFromPositionsAndPrice(
  _client: PoolClient,
  _params: { userId: string; fromTs?: string; toTs?: string; mode: RepairMode },
): Promise<{ rebuiltCount: number }> {
  return { rebuiltCount: 0 };
}
