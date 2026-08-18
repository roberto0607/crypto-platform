/**
 * Execution Agent (Gate 1e) -- turns an `approved` trade_proposals row
 * into a real (paper) order on the Risk Agent's bot account, then
 * protects it with a stop/target OCO pair.
 *
 * No LLM, pure TypeScript -- see the design doc's "Core decision"
 * section. Every judgment call (technical read, sizing, risk approval)
 * has already been made by the time a proposal reaches this gate.
 */
import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../../db/pool";
import { D } from "../../utils/decimal";
import { config } from "../../config";
import { logger } from "../../observability/logContext";
import { placeOrderWithSnapshot, resolveSnapshot } from "../../trading/phase6OrderService";
import { createTriggerOrder, cancelTriggerTx } from "../../triggers/triggerRepo";
import { insertAgentDecisionTx } from "../shared/agentDecisionRepo";
import { ensureRiskAgentBotSetup } from "../riskAgent/botSetup";
import { sendEmail } from "../../email/emailTransport";
import { publish } from "../../events/eventBus";
import { createEvent } from "../../events/eventTypes";

const AGENT_NAME = "execution-agent";
const TRIGGER_RETRY_ATTEMPTS = 3;
const TRIGGER_RETRY_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Distinguishes a timed-out order placement from a genuine
 * placeOrderWithSnapshot rejection, so the catch block in runPhase1 can
 * pick the right execution_failed reason ("order_placement_timeout" vs
 * "order_placement_failed") instead of collapsing both into one.
 */
class OrderPlacementTimeoutError extends Error {
  constructor() {
    super("order_placement_timed_out");
    this.name = "OrderPlacementTimeoutError";
  }
}

/**
 * Direction-aware execution-tolerance check.
 *
 * This pipeline has real latency between a proposal's entry_price being
 * set (Chart Analysis) and execution time (this agent). If price has
 * drifted unfavorably in the meantime, a market order now would land at
 * a larger actual distance to stop_price than what Risk Agent sized and
 * risk-approved for -- i.e. real risk taken could exceed the intended 1%.
 *
 * tolerance = stopDistancePct * 0.5
 *
 * BUY:  reject (return false) if currentPrice > entryPrice * (1 + tolerance)
 *       (price rose -> distance to stop_price widened -> more risk than approved)
 *       (price fell or stayed -> distance to stop_price shrank or held -> safe)
 *
 * SELL: reject (return false) if currentPrice < entryPrice * (1 - tolerance)
 *       (price fell -> distance to stop_price widened -> more risk than approved)
 *       (price rose or stayed -> distance to stop_price shrank or held -> safe)
 *
 * Pure and side-effect free by design -- the only piece of this agent
 * that gets to have "exactly one correct answer given four input
 * combinations," so it's isolated here for exhaustive, hand-verifiable
 * test coverage before anything else is built around it.
 */
export function isWithinExecutionTolerance(params: {
  side: "BUY" | "SELL";
  entryPrice: string;
  currentPrice: string;
  stopDistancePct: string;
}): boolean {
  const entry = D(params.entryPrice);
  const current = D(params.currentPrice);
  const tolerance = D(params.stopDistancePct).mul(0.5);

  if (params.side === "BUY") {
    const limit = entry.mul(D(1).plus(tolerance));
    // Inclusive (lte, not lt) is intentional, not incidental: landing
    // exactly at the limit means real risk taken EQUALS the approved
    // amount, not more than it -- there is no reason to reject an
    // execution that costs exactly what Risk Agent already signed off
    // on. Do not "fix" this to a strict lt without realizing it would
    // contradict that design intent (see the boundary test cases).
    return current.lte(limit);
  }

  const limit = entry.mul(D(1).minus(tolerance));
  // Same reasoning as the BUY branch above -- gte (inclusive), not gt.
  return current.gte(limit);
}

export type ExecutionOutcome = "executed" | "execution_failed" | "skipped";

export interface ExecutionResult {
  proposalId: string;
  outcome: ExecutionOutcome;
  reason: string | null;
  orderId: string | null;
  autoFlattened: boolean;
}

interface TradeProposalRow {
  id: string;
  pair_id: string;
  side: "BUY" | "SELL";
  entry_price: string;
  stop_price: string;
  target_price: string;
  qty: string | null;
  stop_distance_pct: string | null;
  outcome: string;
}

/** Narrowed shape once Phase 1's qty/stop_distance_pct null-guard has passed -- carried into Phase 2 with no `!` assertions needed. Exported so executionAgentRecoveryJob.ts can reconstruct one from a stale trade_proposals row. */
export interface ApprovedProposal {
  id: string;
  pair_id: string;
  side: "BUY" | "SELL";
  entry_price: string;
  stop_price: string;
  target_price: string;
  qty: string;
  stop_distance_pct: string;
}

function skipped(proposalId: string, reason: string): ExecutionResult {
  return { proposalId, outcome: "skipped", reason, orderId: null, autoFlattened: false };
}

/**
 * Marks a proposal `execution_failed` -- no order was ever placed, for
 * any reason (missing qty/stop_distance_pct, tolerance exceeded, or the
 * order-placement call itself throwing). Mirrors evaluator.ts's own
 * rejectTx: writes the outcome + an agent_decisions row, commits, and
 * returns the terminal result. Does NOT release `client` -- that's the
 * caller's (runPhase1's) responsibility via its own try/finally, same as
 * evaluator.ts's rejectTx.
 */
async function failExecutionTx(
  client: PoolClient,
  proposal: TradeProposalRow,
  reason: string,
  reasoning: string,
  inputs?: Record<string, unknown>,
  priceAtDecision?: string,
): Promise<ExecutionResult> {
  await client.query(
    `UPDATE trade_proposals SET outcome = 'execution_failed', closed_at = now() WHERE id = $1`,
    [proposal.id],
  );
  await insertAgentDecisionTx(client, {
    agentName: AGENT_NAME,
    pairId: proposal.pair_id,
    decision: "execution_failed",
    reasoning,
    inputs,
    tradeProposalId: proposal.id,
    priceAtDecision,
  });
  await client.query("COMMIT");

  try {
    publish(createEvent("agent.decision", {
      agentName: AGENT_NAME,
      pairId: proposal.pair_id,
      decision: "execution_failed",
      reasoning,
      tradeProposalId: proposal.id,
      priceAtDecision: priceAtDecision ?? null,
    }));
  } catch (err) {
    logger.warn({ err, proposalId: proposal.id }, "agent_decision_publish_failed");
  }

  logger.warn({ proposalId: proposal.id, reason }, "execution_agent_execution_failed");
  return { proposalId: proposal.id, outcome: "execution_failed", reason, orderId: null, autoFlattened: false };
}

/**
 * Phase 1: row-lock + idempotency check, tolerance check, place the
 * order, and mark the proposal `executed` -- all within ONE held-open
 * transaction/connection. Returns either a terminal result (nothing left
 * to do) or the { proposal, orderId } needed to proceed to Phase 2.
 */
async function runPhase1(
  proposalId: string,
  botUserId: string,
): Promise<
  | { terminal: ExecutionResult }
  | { terminal: null; proposal: ApprovedProposal; orderId: string }
> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<TradeProposalRow>(
      `SELECT id, pair_id, side, entry_price, stop_price, target_price, qty, stop_distance_pct, outcome
       FROM trade_proposals WHERE id = $1 FOR UPDATE`,
      [proposalId],
    );
    const proposal = rows[0];

    if (!proposal) {
      await client.query("ROLLBACK");
      return { terminal: skipped(proposalId, "proposal_not_found") };
    }

    // Idempotency gate, same pattern as evaluator.ts: a proposal whose
    // outcome is no longer 'approved' by the time its row lock is
    // acquired is skipped, not re-acted-on. This is what makes a
    // concurrent/redelivered call for the SAME proposalId safe -- see
    // the "mark executed" comment below for why the lock stays held
    // across order placement rather than being released beforehand.
    if (proposal.outcome !== "approved") {
      await client.query("ROLLBACK");
      return { terminal: skipped(proposalId, `already_${proposal.outcome}`) };
    }

    const qty = proposal.qty;
    const stopDistancePct = proposal.stop_distance_pct;

    // Defense in depth, same philosophy as evaluator.ts's own guard: both
    // columns are nullable at the DB level, but a proposal reaching here
    // with outcome='approved' should always have Risk Agent-populated
    // values for both. Never proceed on a null.
    if (!qty || !stopDistancePct) {
      return {
        terminal: await failExecutionTx(
          client,
          proposal,
          "missing_qty_or_stop_distance",
          `Rejected: missing qty or stop_distance_pct on an approved proposal (qty=${qty ?? "null"}, stopDistancePct=${stopDistancePct ?? "null"}).`,
        ),
      };
    }

    // ── Tolerance check ──
    const snapshot = await resolveSnapshot(botUserId, proposal.pair_id);

    // snapshotStore's "live" path is gated by a 10s staleness TTL --
    // source="fallback" means the live feed has been down long enough
    // that resolveSnapshot fell through to trading_pairs.last_price,
    // which has NO staleness check of its own and could be arbitrarily
    // old. Fail before the tolerance check runs at all rather than let
    // it compare entryPrice against a number that isn't known to be
    // current -- a false "within tolerance" here would be worse than a
    // false rejection, since it would let a real order place on stale
    // information.
    if (snapshot.source === "fallback") {
      return {
        terminal: await failExecutionTx(
          client,
          proposal,
          "stale_price_source",
          `Rejected: price snapshot fell back to trading_pairs.last_price (source="fallback") -- the live feed has been down long enough that this price is not known to be current, so the tolerance check cannot safely run against it (entryPrice=${proposal.entry_price}, snapshotLast=${snapshot.last}, snapshotTs=${snapshot.ts}).`,
          { entryPrice: proposal.entry_price, snapshotLast: snapshot.last, snapshotSource: snapshot.source, snapshotTs: snapshot.ts },
          snapshot.last,
        ),
      };
    }

    const withinTolerance = isWithinExecutionTolerance({
      side: proposal.side,
      entryPrice: proposal.entry_price,
      currentPrice: snapshot.last,
      stopDistancePct,
    });

    if (!withinTolerance) {
      return {
        terminal: await failExecutionTx(
          client,
          proposal,
          "tolerance_exceeded",
          `Rejected: price drifted past the execution-tolerance window before execution (entryPrice=${proposal.entry_price}, currentPrice=${snapshot.last}, stopDistancePct=${stopDistancePct}).`,
          { entryPrice: proposal.entry_price, currentPrice: snapshot.last, stopDistancePct, side: proposal.side },
          snapshot.last,
        ),
      };
    }

    // ── Place the order ──
    // placeOrderWithSnapshot manages its own connection/transaction
    // internally (txWithEvents) -- it cannot be nested into this
    // function's transaction. We deliberately keep `client`'s
    // transaction (and its FOR UPDATE lock on this trade_proposals row)
    // open across this call rather than committing first: Postgres
    // allows a separate connection to freely write to unrelated tables
    // (orders/positions/wallets) while this row stays locked, so there's
    // no deadlock risk. Holding the lock open is what makes a
    // concurrent/redelivered call for this SAME proposalId block here
    // until this transaction commits, instead of racing it into a
    // second real order. idempotencyKey below is a SECOND, independent
    // layer of the same defense, not a replacement for it --
    // idempotencyKey alone would dedupe the order itself but would NOT
    // stop a second caller from independently reaching Phase 2 and
    // registering a duplicate OCO pair against the same position.
    // No internal timeout exists on placeOrderWithSnapshot when called
    // directly (bypassing the HTTP/queue path's own Promise.race in
    // queueManager.ts, which does not apply here) -- and there is no
    // statement_timeout/lock_timeout anywhere in this codebase's DB
    // layer either. Without a bound, a hang here (matching engine, a
    // nested query) would hold this transaction's FOR UPDATE lock on
    // the trade_proposals row indefinitely. Race against the same
    // config.queueTimeoutMs the queue path already uses, rather than
    // inventing a new timeout constant.
    //
    // KNOWN LIMITATION (inherited from queueManager.ts's own
    // Promise.race pattern, not new here): losing the race does not
    // cancel the underlying placeOrderWithSnapshot call. If it
    // eventually succeeds anyway after we've already committed
    // execution_failed below, a real order/position will exist on the
    // bot account with no trade_proposals.executed_order_id linkage to
    // it -- an orphan, not reconciled by anything in this build.
    let orderId: string;
    try {
      const orderPromise = placeOrderWithSnapshot(
        botUserId,
        { pairId: proposal.pair_id, side: proposal.side, type: "MARKET", qty },
        `execution-agent:${proposalId}`,
        undefined,
        null,
        null,
        "agent",
      );
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new OrderPlacementTimeoutError()), config.queueTimeoutMs);
      });
      const result = await Promise.race([orderPromise, timeoutPromise]);
      orderId = result.order.id;
    } catch (err) {
      const isTimeout = err instanceof OrderPlacementTimeoutError;
      return {
        terminal: await failExecutionTx(
          client,
          proposal,
          isTimeout ? "order_placement_timeout" : "order_placement_failed",
          isTimeout
            ? `Rejected: order placement did not complete within ${config.queueTimeoutMs}ms.`
            : `Rejected: order placement failed (${err instanceof Error ? err.message : "unknown_error"}).`,
        ),
      };
    }

    // ── Mark executed -- durably, BEFORE Phase 2 runs ──
    // This is what makes the row un-redeliverable: it commits on the
    // SAME transaction that has held this row's FOR UPDATE lock since
    // the top of this function, so any concurrent call for this
    // proposalId that was blocked on that lock now sees
    // outcome='executed' (not 'approved') and skips instead of placing a
    // second order. It also durably records executed_order_id BEFORE
    // Phase 2 (trigger registration) runs -- this is what the
    // crash-recovery job depends on: it scans for outcome='executed'
    // rows with no matching ACTIVE trigger_orders. If 'executed' were
    // only set AFTER Phase 2 succeeded instead (the design doc's
    // original numbered list had this backwards), a crash between Phase
    // 1 and Phase 2 would leave outcome stuck at 'approved' with a real
    // order already placed -- invisible to this recovery query, and a
    // retry/redelivery would place a DUPLICATE order. Do not move this
    // after trigger registration.
    await client.query(
      `UPDATE trade_proposals SET outcome = 'executed', executed_order_id = $1, closed_at = now() WHERE id = $2`,
      [orderId, proposalId],
    );
    await insertAgentDecisionTx(client, {
      agentName: AGENT_NAME,
      pairId: proposal.pair_id,
      decision: "executed",
      reasoning: `Executed: placed ${proposal.side} MARKET order for ${qty} (orderId=${orderId}).`,
      tradeProposalId: proposalId,
      priceAtDecision: snapshot.last,
    });
    await client.query("COMMIT");

    try {
      publish(createEvent("agent.decision", {
        agentName: AGENT_NAME,
        pairId: proposal.pair_id,
        decision: "executed",
        reasoning: `Executed: placed ${proposal.side} MARKET order for ${qty} (orderId=${orderId}).`,
        tradeProposalId: proposalId,
        priceAtDecision: snapshot.last,
      }));
    } catch (err) {
      logger.warn({ err, proposalId }, "agent_decision_publish_failed");
    }

    logger.info({ proposalId, pairId: proposal.pair_id, orderId }, "execution_agent_order_placed");

    const approvedProposal: ApprovedProposal = {
      id: proposal.id,
      pair_id: proposal.pair_id,
      side: proposal.side,
      entry_price: proposal.entry_price,
      stop_price: proposal.stop_price,
      target_price: proposal.target_price,
      qty,
      stop_distance_pct: stopDistancePct,
    };

    return { terminal: null, proposal: approvedProposal, orderId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error({ proposalId, err }, "execution_agent_unexpected_error");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Pages a human when the recovery job's own retry of a stuck proposal
 * fails again -- see registerProtectionOrFlatten's origin==='recovery'
 * branch below. Claims human_alerted_at atomically so a
 * persistently-stuck row (re-flagged every 60s by
 * executionAgentRecoveryJob, indefinitely, since flatten_order_id never
 * gets set on this path) alerts exactly once, not once per tick.
 *
 * Best-effort and must never throw: this is a secondary feature
 * piggybacking on registerProtectionOrFlatten's primary job of
 * recording the agent_decisions row, and a DB blip or SendGrid failure
 * here must not prevent that from happening -- the whole body is one
 * try/catch, not just the send.
 */
async function alertHumanOnRecoveryFailure(
  proposalId: string,
  pairId: string,
  orderId: string,
): Promise<void> {
  try {
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE trade_proposals SET human_alerted_at = now() WHERE id = $1 AND human_alerted_at IS NULL RETURNING id`,
      [proposalId],
    );
    if (rows.length === 0) return; // already alerted -- another tick/instance won the claim

    if (!config.opsAlertEmail) {
      logger.warn({ proposalId }, "execution_agent_human_alert_skipped_no_ops_email");
      return;
    }

    await sendEmail(
      config.opsAlertEmail,
      `TRADR: unprotected position needs manual intervention (${pairId})`,
      `<p>Trade proposal <code>${proposalId}</code> (order <code>${orderId}</code>, pair ${pairId}) failed protection registration, auto-flatten, AND the crash-recovery retry. The position is open and unprotected. Manual intervention required.</p>`,
    );
  } catch (err) {
    logger.error({ proposalId, err }, "execution_agent_human_alert_failed");
  }
}

/**
 * Phase 2: register the stop/target OCO pair for a just-executed
 * proposal. Runs AFTER Phase 1's transaction has committed and released
 * its client -- a separate transaction/connection, matching
 * createTriggerOrder's existing non-Tx design (see triggerRepo.ts).
 * Retried up to TRIGGER_RETRY_ATTEMPTS times -- these are internal DB
 * writes, not a rate-limited external API, so failures here are expected
 * to be transient.
 *
 * On exhausting retries: auto-flatten (opposing market order to close)
 * rather than leave a real, unprotected position open. outcome stays
 * 'executed' (already committed in Phase 1) -- this trade DID execute,
 * it just lost its protection and had to be emergency-closed. This path
 * logs and records a distinct, loud signal
 * (risk_agent_position_auto_flattened) so it can never be mistaken for a
 * normal healthy execution in logs or agent_decisions.
 *
 * Exported (not just called from executeTradeProposal below) because
 * executionAgentRecoveryJob.ts calls this directly against a
 * reconstructed ApprovedProposal for rows that crashed mid-Phase-2 or
 * whose earlier auto-flatten also failed. `origin` distinguishes that
 * call site: on `origin === "recovery"` and a flatten that ALSO fails
 * here, this is a SECOND consecutive failure to protect or close the
 * same position, not a fresh first-time one -- it gets its own log
 * event (execution_agent_recovery_also_failed) and its own
 * agent_decisions.decision value (recovery_also_failed instead of
 * auto_flattened) rather than silently reusing the first failure's
 * signal, so "tried twice, still broken" is never indistinguishable
 * from "failed once, already resolved."
 */
export async function registerProtectionOrFlatten(
  proposal: ApprovedProposal,
  orderId: string,
  botUserId: string,
  origin: "phase2" | "recovery" = "phase2",
): Promise<ExecutionResult> {
  const proposalId = proposal.id;
  const closingSide: "BUY" | "SELL" = proposal.side === "BUY" ? "SELL" : "BUY";
  const ocoGroupId = crypto.randomUUID();

  // Track each leg's registered trigger id independently, not just a
  // pass/fail boolean. createTriggerOrder has no uniqueness constraint
  // (confirmed against the live schema -- trigger_orders has no UNIQUE
  // index beyond the id PK), so blindly re-running BOTH calls from
  // scratch on every retry attempt would insert a DUPLICATE
  // STOP_MARKET/TAKE_PROFIT_MARKET row if one leg already succeeded on
  // an earlier attempt. Two ACTIVE stop legs for the same position both
  // firing on a price move would turn a clean stop-loss into an
  // accidental reverse position. Retry only whichever leg is still
  // missing.
  let stopTriggerId: string | null = null;
  let targetTriggerId: string | null = null;
  let lastTriggerError: unknown = null;

  for (let attempt = 1; attempt <= TRIGGER_RETRY_ATTEMPTS; attempt++) {
    try {
      if (!stopTriggerId) {
        const stopTrigger = await createTriggerOrder({
          userId: botUserId,
          pairId: proposal.pair_id,
          kind: "STOP_MARKET",
          side: closingSide,
          triggerPrice: proposal.stop_price,
          qty: proposal.qty,
          ocoGroupId,
          tradeProposalId: proposalId,
        });
        stopTriggerId = stopTrigger.id;
      }
      if (!targetTriggerId) {
        const targetTrigger = await createTriggerOrder({
          userId: botUserId,
          pairId: proposal.pair_id,
          kind: "TAKE_PROFIT_MARKET",
          side: closingSide,
          triggerPrice: proposal.target_price,
          qty: proposal.qty,
          ocoGroupId,
          tradeProposalId: proposalId,
        });
        targetTriggerId = targetTrigger.id;
      }

      logger.info({ proposalId, pairId: proposal.pair_id, orderId, ocoGroupId }, "execution_agent_protection_registered");
      return { proposalId, outcome: "executed", reason: null, orderId, autoFlattened: false };
    } catch (err) {
      lastTriggerError = err;
      logger.warn(
        { proposalId, attempt, stopTriggerId, targetTriggerId, err },
        "execution_agent_trigger_registration_attempt_failed",
      );
      if (attempt < TRIGGER_RETRY_ATTEMPTS) await sleep(TRIGGER_RETRY_DELAY_MS);
    }
  }

  logger.error(
    { proposalId, pairId: proposal.pair_id, orderId, stopTriggerId, targetTriggerId, lastTriggerError },
    "risk_agent_position_auto_flattened",
  );

  // If exactly one leg DID register (e.g. STOP_MARKET succeeded but
  // TAKE_PROFIT_MARKET never did across all retries), it's a real
  // ACTIVE trigger sitting against a position we're about to close
  // below. Left alone, it would fire on a future price move against a
  // position that no longer exists, placing an unwanted/reversing
  // order. Cancel whichever leg(s) did register BEFORE flattening, so
  // auto-flatten actually leaves the account clean.
  const survivingTriggerIds = [stopTriggerId, targetTriggerId].filter((id): id is string => id !== null);
  if (survivingTriggerIds.length > 0) {
    const cancelClient = await pool.connect();
    try {
      await cancelClient.query("BEGIN");
      for (const triggerId of survivingTriggerIds) {
        await cancelTriggerTx(cancelClient, triggerId);
      }
      await cancelClient.query("COMMIT");
    } catch (cancelErr) {
      await cancelClient.query("ROLLBACK").catch(() => {});
      logger.error({ proposalId, survivingTriggerIds, cancelErr }, "execution_agent_stray_trigger_cancel_failed");
    } finally {
      cancelClient.release();
    }
  }

  let flattenOrderId: string | null = null;
  let flattenError: unknown = null;
  try {
    const flattenResult = await placeOrderWithSnapshot(
      botUserId,
      { pairId: proposal.pair_id, side: closingSide, type: "MARKET", qty: proposal.qty },
      `execution-agent:${proposalId}:flatten`,
      undefined,
      null,
      null,
      "agent",
    );
    flattenOrderId = flattenResult.order.id;
  } catch (err) {
    flattenError = err;
    logger.error({ proposalId, err }, "execution_agent_auto_flatten_failed");
  }

  // RESOLVED (was "KNOWN UNRESOLVED GAP"): this branch is reached when
  // protection registration exhausts retries AND the flatten attempt
  // ALSO fails, leaving the position open and unprotected.
  //
  // Two gaps used to exist here, both now closed:
  //   1. "The only trace is a reasoning string" -- closed by
  //      flatten_order_id (migration 089): it stays NULL here (set only
  //      in the success branch below), a real column instead of
  //      string-matching agent_decisions.reasoning.
  //   2. "The recovery job's detection query can't structurally
  //      distinguish crashed-before-Phase-2 from ran-to-completion-and-
  //      both-remediation-paths-failed" -- moot: executionAgentRecoveryJob.ts
  //      (jobs/definitions/) doesn't need to distinguish them, since both
  //      get the identical remedy (call this function again via the
  //      `origin: "recovery"` path below). Its detection query requires
  //      BOTH "no complete healthy STOP_MARKET/TAKE_PROFIT_MARKET pair"
  //      AND flatten_order_id IS NULL, which this branch always satisfies.
  //
  // A persistently-failing flatten (not a transient blip -- e.g. a
  // delisted pair, sustained insufficient liquidity) means the recovery
  // job will keep re-flagging and re-attempting this row every tick,
  // escalating a louder execution_agent_recovery_also_failed +
  // decision:"recovery_also_failed" signal each time rather than looping
  // silently. alertHumanOnRecoveryFailure below pages a human on this
  // branch -- claimed once via human_alerted_at (migration 090) so the
  // 60s recovery-job tick doesn't re-page on every retry of the same
  // still-stuck row.
  const recoveryAlsoFailed = origin === "recovery" && !flattenOrderId;
  if (recoveryAlsoFailed) {
    // Distinct from the risk_agent_position_auto_flattened /
    // execution_agent_auto_flatten_failed lines already logged above --
    // those fire on ANY exhausted-retry/failed-flatten, including a
    // fresh first-time failure. This one only fires when the RECOVERY
    // job's own retry of this exact proposal ALSO failed -- a second
    // consecutive failure to protect or close the same position, which
    // needs to read as categorically louder than a first-time failure,
    // not an identical repeat of the same signal.
    logger.error(
      { proposalId, pairId: proposal.pair_id, orderId, stopTriggerId, targetTriggerId, lastTriggerError, flattenError },
      "execution_agent_recovery_also_failed",
    );
    await alertHumanOnRecoveryFailure(proposalId, proposal.pair_id, orderId);
  }

  const decisionValue = recoveryAlsoFailed ? "recovery_also_failed" : "auto_flattened";
  const decisionReasoning = flattenOrderId
    ? `Protection registration failed after ${TRIGGER_RETRY_ATTEMPTS} attempts (${lastTriggerError instanceof Error ? lastTriggerError.message : "unknown_error"}); position emergency-closed via opposing market order (flattenOrderId=${flattenOrderId}).`
    : recoveryAlsoFailed
      ? `RECOVERY-TRIGGERED RETRY ALSO FAILED: protection registration failed after ${TRIGGER_RETRY_ATTEMPTS} attempts (${lastTriggerError instanceof Error ? lastTriggerError.message : "unknown_error"}); auto-flatten ALSO failed (${flattenError instanceof Error ? flattenError.message : "unknown_error"}) -- this is a SECOND consecutive failure to protect or close this position (the crash-recovery job retried it and it failed again). Position remains open and UNPROTECTED; needs manual intervention.`
      : `Protection registration failed after ${TRIGGER_RETRY_ATTEMPTS} attempts (${lastTriggerError instanceof Error ? lastTriggerError.message : "unknown_error"}); auto-flatten ALSO failed (${flattenError instanceof Error ? flattenError.message : "unknown_error"}) -- position remains open and UNPROTECTED, needs manual intervention.`;

  const decisionClient = await pool.connect();
  let decisionCommitted = false;
  try {
    await decisionClient.query("BEGIN");
    if (flattenOrderId) {
      await decisionClient.query(
        `UPDATE trade_proposals SET flatten_order_id = $1 WHERE id = $2`,
        [flattenOrderId, proposalId],
      );
    }
    await insertAgentDecisionTx(decisionClient, {
      agentName: AGENT_NAME,
      pairId: proposal.pair_id,
      decision: decisionValue,
      reasoning: decisionReasoning,
      tradeProposalId: proposalId,
    });
    await decisionClient.query("COMMIT");
    decisionCommitted = true;
  } catch (decisionErr) {
    await decisionClient.query("ROLLBACK").catch(() => {});
    logger.error({ proposalId, decisionErr }, "execution_agent_auto_flatten_decision_log_failed");
  } finally {
    decisionClient.release();
  }

  // Broadcast OUTSIDE the decisionClient try/catch above, gated on
  // decisionCommitted -- this function's DB write is itself allowed to
  // fail-and-swallow (see the catch above), so unlike every other site in
  // this file, reaching "after the try/catch" does NOT imply the write
  // succeeded. Publishing here must never fire for a decision that was
  // never durably written, and a publish() failure must never be logged
  // under execution_agent_auto_flatten_decision_log_failed -- that event
  // name specifically means the DB write failed, which would be
  // misleading if the write actually succeeded and only the broadcast did not.
  if (decisionCommitted) {
    try {
      publish(createEvent("agent.decision", {
        agentName: AGENT_NAME,
        pairId: proposal.pair_id,
        decision: decisionValue,
        reasoning: decisionReasoning,
        tradeProposalId: proposalId,
        priceAtDecision: null,
      }));
    } catch (err) {
      logger.warn({ err, proposalId }, "agent_decision_publish_failed");
    }
  }

  return {
    proposalId,
    outcome: "executed",
    reason: decisionValue,
    orderId,
    autoFlattened: true,
  };
}

/**
 * Execution Agent (Gate 1e) public entry point -- turns one `approved`
 * trade_proposals row into a real order + protective OCO pair, or a
 * terminal execution_failed/skipped result. See runPhase1 and
 * registerProtectionOrFlatten above for the two-phase sequence and why
 * the 'executed' commit sits between them, not after both.
 */
export async function executeTradeProposal(proposalId: string): Promise<ExecutionResult> {
  await ensureRiskAgentBotSetup();
  const botUserId = config.riskAgentBotUserId;

  const phase1 = await runPhase1(proposalId, botUserId);
  if (phase1.terminal) return phase1.terminal;

  return registerProtectionOrFlatten(phase1.proposal, phase1.orderId, botUserId);
}
