import { pool } from "../../db/pool";
import { config } from "../../config";
import { logger } from "../../observability/logContext";
import { autoCreateWallets } from "../../wallets/autoWallets";

let botInitialized = false;

/**
 * Verify the Risk Agent bot user exists (migration 086) and its free-play
 * wallets are created + funded. Reuses autoCreateWallets -- the same
 * idempotent "create one wallet per asset, fund only the free-play USD
 * wallet with STARTING_CAPITAL_USD" path every free-play/registration user
 * already goes through (see the design doc: "same $100K convention as
 * free-play accounts"), rather than reimplementing the
 * ADMIN_CREDIT-ledger-entry funding logic marketMakerJob.ts's
 * ensureBotSetup hand-rolls for its own (much larger, multi-asset) bot
 * balance needs.
 *
 * Safe to call on every evaluation -- the in-memory botInitialized flag
 * (same pattern as marketMakerJob.ts) short-circuits everything after the
 * first successful call within a process lifetime; autoCreateWallets
 * itself is also idempotent if called again anyway.
 */
export async function ensureRiskAgentBotSetup(): Promise<void> {
  if (botInitialized) return;

  const botUserId = config.riskAgentBotUserId;
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [botUserId]);
  if (rows.length === 0) {
    logger.error({ botUserId }, "risk_agent_bot_user_missing");
    throw new Error("Risk Agent bot user not found. Run migration 086.");
  }

  await autoCreateWallets(botUserId, null);
  botInitialized = true;
  logger.info({ botUserId }, "risk_agent_bot_initialized");
}
