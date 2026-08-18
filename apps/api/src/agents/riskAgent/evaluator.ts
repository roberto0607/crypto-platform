/**
 * Risk Agent (Gate 1d) -- deterministic evaluation of one `pending`
 * trade_proposals row: approve (with a computed qty), reject, or expire.
 *
 * No LLM, pure TypeScript -- see the design doc's "Core decision" section.
 * Position sizing and exposure limits have exactly one correct answer
 * given the inputs, unlike Scanner/Chart Analysis's genuine judgment
 * calls, and this is the hard gate before any eventual (paper) order --
 * it should not be subject to the same flakiness class as an
 * opinion-generating agent.
 */
import type { PoolClient } from "pg";
import Decimal from "decimal.js";
import { pool } from "../../db/pool";
import { D, ZERO } from "../../utils/decimal";
import { config } from "../../config";
import { logger } from "../../observability/logContext";
import { getPortfolioSummary } from "../../portfolio/portfolioService";
import { getTotalOpenRiskTx, insertRiskReservationTx } from "./reservationRepo";
import { insertAgentDecisionTx } from "../shared/agentDecisionRepo";
import { ensureRiskAgentBotSetup } from "./botSetup";
import { publish } from "../../events/eventBus";
import { createEvent } from "../../events/eventTypes";

const AGENT_NAME = "risk-agent";

// Flat across scalp/swing -- concurrency/stacking risk (e.g. many scalps
// open at once) is handled by TOTAL_EXPOSURE_CAP_PCT, not per-trade-type
// variance. See the design doc's sizing formula section.
const RISK_PER_TRADE_PCT = D("0.01");
const TOTAL_EXPOSURE_CAP_PCT = D("0.05");
// Not a solvency limit (100% of equity would be that) -- a backstop against
// stop-slippage/gap risk. qty has no ceiling relative to equity on its own:
// risk_amount_quote is capped at 1% of equity, but stopDistancePct sits in
// qty's denominator, so a tight enough stop (exactly what volatile-chop/
// scalp setups regularly produce) inflates qty arbitrarily to still hit
// that same 1% risk target. A real Gate 1c proposal observed
// stopDistancePct=0.005017 (~0.5%) implies ~199% of equity in notional on a
// SINGLE trade at only 1% stated risk. Tight stops are exactly the ones
// most likely to slip/gap past their stated price in a fast market, so this
// caps how much notional can ride on any one stop actually executing as
// intended.
const NOTIONAL_CAP_PCT = D("0.20");

interface TradeProposalRow {
  id: string;
  pair_id: string;
  outcome: string;
  entry_price: string;
  stop_price: string;
  stop_distance_pct: string | null;
  expires_at: string;
}

export type RiskDecision = "approved" | "rejected" | "expired" | "skipped";

export interface RiskEvaluationResult {
  proposalId: string;
  decision: RiskDecision;
  reason: string | null;
  qty: string | null;
  riskAmountQuote: string | null;
}

function skipped(proposalId: string, reason: string): RiskEvaluationResult {
  return { proposalId, decision: "skipped", reason, qty: null, riskAmountQuote: null };
}

/**
 * Evaluates one trade_proposals row end-to-end. Idempotent against
 * redelivery: a proposal whose outcome is no longer 'pending' by the time
 * its row lock is acquired is skipped, not re-evaluated.
 */
export async function evaluateTradeProposal(proposalId: string): Promise<RiskEvaluationResult> {
  await ensureRiskAgentBotSetup();
  const botUserId = config.riskAgentBotUserId;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Advisory xact lock scoped to this bot's exposure accounting --
    // released automatically on COMMIT/ROLLBACK (see eventService.ts's
    // pg_advisory_xact_lock precedent). Serializes concurrent evaluations
    // against the same bot account so the open-risk sum + exposure-cap
    // check + reservation insert below are atomic together, not just
    // "probably fine due to timing" (see the design doc's race-condition
    // section).
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`risk_agent:${botUserId}`]);

    const { rows } = await client.query<TradeProposalRow>(
      `SELECT id, pair_id, outcome, entry_price, stop_price, stop_distance_pct, expires_at
       FROM trade_proposals WHERE id = $1 FOR UPDATE`,
      [proposalId],
    );
    const proposal = rows[0];
    if (!proposal) {
      await client.query("ROLLBACK");
      return skipped(proposalId, "proposal_not_found");
    }
    if (proposal.outcome !== "pending") {
      await client.query("ROLLBACK");
      return skipped(proposalId, `already_${proposal.outcome}`);
    }

    if (new Date(proposal.expires_at).getTime() <= Date.now()) {
      await client.query(
        `UPDATE trade_proposals SET outcome = 'expired', closed_at = now() WHERE id = $1`,
        [proposalId],
      );
      await insertAgentDecisionTx(client, {
        agentName: AGENT_NAME,
        pairId: proposal.pair_id,
        decision: "expired",
        reasoning: "Proposal expired before Risk Agent evaluation.",
        tradeProposalId: proposalId,
      });
      await client.query("COMMIT");

      try {
        publish(createEvent("agent.decision", {
          agentName: AGENT_NAME,
          pairId: proposal.pair_id,
          decision: "expired",
          reasoning: "Proposal expired before Risk Agent evaluation.",
          tradeProposalId: proposalId,
          priceAtDecision: null,
        }));
      } catch (err) {
        logger.warn({ err, proposalId }, "agent_decision_publish_failed");
      }

      return { proposalId, decision: "expired", reason: "expired_before_evaluation", qty: null, riskAmountQuote: null };
    }

    const entryPrice = D(proposal.entry_price);
    const stopDistancePct = proposal.stop_distance_pct !== null ? D(proposal.stop_distance_pct) : null;

    // Defense in depth, same philosophy as chartAnalysisEngine.ts's
    // computeStopDistance guard: a proposal reaching here should always
    // have a positive entryPrice (tradeProposalSchema's positiveDecimalStr)
    // and a positive stop_distance_pct (migration 085), but this column is
    // nullable at the DB level and this agent must never divide by zero/
    // null into a fabricated qty.
    if (!entryPrice.isFinite() || entryPrice.lte(ZERO) || stopDistancePct === null || !stopDistancePct.isFinite() || stopDistancePct.lte(ZERO)) {
      return await rejectTx(client, proposal, "missing_or_invalid_stop_distance",
        `Rejected: missing or invalid stop distance (entryPrice=${proposal.entry_price}, stopDistancePct=${proposal.stop_distance_pct ?? "null"}).`);
    }

    // getPortfolioSummary reads via the shared pool, not this client/tx --
    // acceptable per the design doc's own timing argument (evaluations are
    // far enough apart in practice, and equity from mark-to-market prices
    // is already continuously moving regardless of this read). Only the
    // exposure-cap check itself needs to be atomic with the reservation
    // insert, which is what the advisory lock above guarantees.
    const summary = await getPortfolioSummary(botUserId, undefined, null);
    const equity = D(summary.equity_quote);
    const riskAmountQuote = equity.mul(RISK_PER_TRADE_PCT);
    const qty = riskAmountQuote.div(entryPrice.mul(stopDistancePct));

    // Notional cap check runs BEFORE the open-risk DB round-trip below --
    // no reason to spend a query on the portfolio-level exposure sum for a
    // proposal that's about to be rejected on notional grounds anyway.
    const notionalQuote = qty.mul(entryPrice);
    const notionalCap = equity.mul(NOTIONAL_CAP_PCT);

    if (notionalQuote.gt(notionalCap)) {
      return await rejectTx(client, proposal, "notional_cap_exceeded",
        `Rejected: notional exposure ${notionalQuote.toFixed(8)} would exceed the ${NOTIONAL_CAP_PCT.mul(100).toFixed(0)}% notional cap (${notionalCap.toFixed(8)}) of equity ${equity.toFixed(8)}.`,
        {
          equityQuote: summary.equity_quote,
          entryPrice: proposal.entry_price,
          stopDistancePct: proposal.stop_distance_pct,
          riskAmountQuote: riskAmountQuote.toFixed(8),
          qty: qty.toFixed(8),
          notionalQuote: notionalQuote.toFixed(8),
          notionalCapPct: NOTIONAL_CAP_PCT.toNumber(),
          notionalCapQuote: notionalCap.toFixed(8),
        });
    }

    const totalOpenRiskBefore = await getTotalOpenRiskTx(client, botUserId);
    const cap = equity.mul(TOTAL_EXPOSURE_CAP_PCT);
    const totalOpenRiskAfter = totalOpenRiskBefore.plus(riskAmountQuote);

    const inputs = {
      equityQuote: summary.equity_quote,
      entryPrice: proposal.entry_price,
      stopDistancePct: proposal.stop_distance_pct,
      riskPerTradePct: RISK_PER_TRADE_PCT.toNumber(),
      riskAmountQuote: riskAmountQuote.toFixed(8),
      qty: qty.toFixed(8),
      notionalQuote: notionalQuote.toFixed(8),
      notionalCapPct: NOTIONAL_CAP_PCT.toNumber(),
      notionalCapQuote: notionalCap.toFixed(8),
      totalOpenRiskBefore: totalOpenRiskBefore.toFixed(8),
      totalOpenRiskAfter: totalOpenRiskAfter.toFixed(8),
      exposureCapPct: TOTAL_EXPOSURE_CAP_PCT.toNumber(),
      exposureCapQuote: cap.toFixed(8),
    };

    if (totalOpenRiskAfter.gt(cap)) {
      return await rejectTx(client, proposal, "exposure_cap_exceeded",
        `Rejected: total open risk ${totalOpenRiskAfter.toFixed(8)} would exceed the ${TOTAL_EXPOSURE_CAP_PCT.mul(100).toFixed(0)}% cap (${cap.toFixed(8)}) of equity ${equity.toFixed(8)}.`,
        inputs, riskAmountQuote);
    }

    const qtyStr = qty.toFixed(8);
    const riskAmountStr = riskAmountQuote.toFixed(8);

    await client.query(
      `UPDATE trade_proposals SET outcome = 'approved', qty = $1 WHERE id = $2`,
      [qtyStr, proposalId],
    );
    await insertRiskReservationTx(client, {
      proposalId,
      userId: botUserId,
      pairId: proposal.pair_id,
      riskAmountQuote: riskAmountStr,
    });
    await insertAgentDecisionTx(client, {
      agentName: AGENT_NAME,
      pairId: proposal.pair_id,
      decision: "approved",
      reasoning: `Approved: sized ${qtyStr} at ${RISK_PER_TRADE_PCT.mul(100).toFixed(0)}% risk (${riskAmountStr} quote); total open risk after: ${totalOpenRiskAfter.toFixed(8)} of ${cap.toFixed(8)} cap.`,
      inputs,
      tradeProposalId: proposalId,
      priceAtDecision: proposal.entry_price,
    });
    await client.query("COMMIT");

    // Trigger the Execution Agent (Gate 1e) -- fire alongside, not instead
    // of, this function's own return value (see
    // RiskAgentProposalApprovedData's comment for why the payload stays
    // minimal). Same pattern as chartAnalysis/runner.ts publishing
    // chart_analysis.proposal_created right after its own insert.
    //
    // BUG FIX (found during agent.decision recon, unrelated to that
    // feature): this call used to be unguarded. eventBus.ts's publish()
    // can throw synchronously (its Redis fan-out does an un-try/catch'd
    // JSON.stringify before the fire-and-forget redis.publish().catch()) --
    // if it did, the exception would propagate out of THIS try block, hit
    // the catch below, attempt a no-op ROLLBACK, and rethrow to the caller
    // even though the trade above already committed successfully. A
    // broadcast-layer failure after COMMIT must never be reported as an
    // evaluation failure.
    try {
      publish(createEvent("risk_agent.proposal_approved", { proposalId, pairId: proposal.pair_id }));
    } catch (err) {
      logger.warn({ err, proposalId }, "risk_agent_proposal_approved_publish_failed");
    }

    try {
      publish(createEvent("agent.decision", {
        agentName: AGENT_NAME,
        pairId: proposal.pair_id,
        decision: "approved",
        reasoning: `Approved: sized ${qtyStr} at ${RISK_PER_TRADE_PCT.mul(100).toFixed(0)}% risk (${riskAmountStr} quote); total open risk after: ${totalOpenRiskAfter.toFixed(8)} of ${cap.toFixed(8)} cap.`,
        tradeProposalId: proposalId,
        priceAtDecision: proposal.entry_price,
      }));
    } catch (err) {
      logger.warn({ err, proposalId }, "agent_decision_publish_failed");
    }

    logger.info({ proposalId, pairId: proposal.pair_id, qty: qtyStr, riskAmountQuote: riskAmountStr }, "risk_agent_approved");
    return { proposalId, decision: "approved", reason: null, qty: qtyStr, riskAmountQuote: riskAmountStr };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error({ err, proposalId }, "risk_agent_evaluation_error");
    throw err;
  } finally {
    client.release();
  }
}

async function rejectTx(
  client: PoolClient,
  proposal: TradeProposalRow,
  reason: string,
  reasoning: string,
  inputs?: Record<string, unknown>,
  riskAmountQuote?: Decimal,
): Promise<RiskEvaluationResult> {
  await client.query(
    `UPDATE trade_proposals SET outcome = 'rejected', closed_at = now() WHERE id = $1`,
    [proposal.id],
  );
  await insertAgentDecisionTx(client, {
    agentName: AGENT_NAME,
    pairId: proposal.pair_id,
    decision: "rejected",
    reasoning,
    inputs,
    tradeProposalId: proposal.id,
    priceAtDecision: proposal.entry_price,
  });
  await client.query("COMMIT");

  try {
    publish(createEvent("agent.decision", {
      agentName: AGENT_NAME,
      pairId: proposal.pair_id,
      decision: "rejected",
      reasoning,
      tradeProposalId: proposal.id,
      priceAtDecision: proposal.entry_price,
    }));
  } catch (err) {
    logger.warn({ err, proposalId: proposal.id }, "agent_decision_publish_failed");
  }

  return {
    proposalId: proposal.id,
    decision: "rejected",
    reason,
    qty: null,
    riskAmountQuote: riskAmountQuote ? riskAmountQuote.toFixed(8) : null,
  };
}
