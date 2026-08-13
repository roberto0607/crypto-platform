/**
 * Track 2 -- direct-invocation concurrency test for Risk Agent + Execution
 * Agent. Bypasses Scanner/Chart Analysis and the event bus entirely:
 * synthetic trade_proposals rows are inserted via raw SQL, then
 * evaluateTradeProposal()/executeTradeProposal() are called directly and
 * concurrently -- same no-HTTP, no-LLM pattern as simCompetition.ts.
 *
 * Requires a running dev server with REDIS_URL set: Test B's live-price
 * check reads Redis' snap:BTC/USD key, written by that server's Coinbase
 * WS ingestion. This script's own process can't see a same-process
 * in-memory snapshot store -- only the shared Redis one.
 *
 * Usage:
 *   cd apps/api && npx tsx src/scripts/agentConcurrencyTest.ts
 */

import { pool } from "../db/pool";
import { config } from "../config";
import { evaluateTradeProposal, type RiskEvaluationResult } from "../agents/riskAgent/evaluator";
import { executeTradeProposal, type ExecutionResult } from "../agents/executionAgent/executor";
import { resolveSnapshot, placeOrderWithSnapshot } from "../trading/phase6OrderService";
import { getPortfolioSummary } from "../portfolio/portfolioService";
import { ensureRiskAgentBotSetup } from "../agents/riskAgent/botSetup";

const AGENT_NAME_TAG = "concurrency-test";
const PAIR_SYMBOL = "BTC/USD";
const TEST_A_N = 10;
const TEST_B_N = 10;
const RISK_PER_TRADE_PCT = 0.01;     // must match evaluator.ts's RISK_PER_TRADE_PCT
const TOTAL_EXPOSURE_CAP_PCT = 0.05; // must match evaluator.ts's TOTAL_EXPOSURE_CAP_PCT
// >5% keeps notional well under the 20% notional cap at 1% risk/trade --
// see evaluator.ts's own comment on tight stops inflating qty.
const STOP_DISTANCE_PCT = "0.10";
const TEST_B_QTY = "0.001"; // used by both insertApprovedProposal and flattenTestBPosition

type TimedCall<T> = { index: number; startMs: number; elapsedMs: number; result?: T; error?: unknown };

async function timed<T>(index: number, batchStart: number, fn: () => Promise<T>): Promise<TimedCall<T>> {
  const startMs = performance.now() - batchStart;
  const t0 = performance.now();
  try {
    const result = await fn();
    return { index, startMs, elapsedMs: performance.now() - t0, result };
  } catch (error) {
    return { index, startMs, elapsedMs: performance.now() - t0, error };
  }
}

function printTimings<T>(label: string, calls: TimedCall<T>[]): void {
  console.log(`\n  ${label} per-call timing (offset ms from batch start, elapsed ms):`);
  for (const c of [...calls].sort((a, b) => a.index - b.index)) {
    console.log(`    #${c.index}  start=+${c.startMs.toFixed(1)}ms  elapsed=${c.elapsedMs.toFixed(1)}ms`);
  }
  const elapsed = calls.map((c) => c.elapsedMs);
  const avg = elapsed.reduce((a, b) => a + b, 0) / elapsed.length;
  console.log(`    avg elapsed=${avg.toFixed(1)}ms  max elapsed=${Math.max(...elapsed).toFixed(1)}ms`);
}

async function getPairId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM trading_pairs WHERE symbol = $1`,
    [PAIR_SYMBOL],
  );
  if (!rows[0]) throw new Error(`${PAIR_SYMBOL} pair not found -- run pnpm seed:loadtest first.`);
  return rows[0].id;
}

async function cleanupPriorRuns(): Promise<void> {
  // FK-safe order: risk_reservations.proposal_id references trade_proposals(id),
  // no ON DELETE clause (defaults to RESTRICT) -- must delete reservations first.
  await pool.query(
    `DELETE FROM risk_reservations WHERE proposal_id IN (SELECT id FROM trade_proposals WHERE agent_name = $1)`,
    [AGENT_NAME_TAG],
  );
  const { rowCount } = await pool.query(`DELETE FROM trade_proposals WHERE agent_name = $1`, [AGENT_NAME_TAG]);
  console.log(`Cleanup: removed ${rowCount} leftover proposal(s) + their reservations from prior runs.`);
}

async function currentOpenRisk(botUserId: string): Promise<number> {
  // Read-only mirror of reservationRepo.getTotalOpenRiskTx -- a pre-test
  // snapshot for reporting/expected-count math, not part of the actual
  // exposure-cap check (which runs inside evaluator.ts's own advisory lock).
  // Deliberately account-wide, NOT scoped to any one pair_id -- the real
  // function sums risk across every pair the bot has reserved risk on
  // (the EXISTS join only correlates each reservation's OWN pair to that
  // pair's own position; the outer WHERE filters by user_id alone). An
  // earlier version of this helper incorrectly added `AND r.pair_id = $2`,
  // which silently hid real cross-pair exposure and produced a wrong
  // expected-approval count.
  const { rows } = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(r.risk_amount_quote), 0) AS total
     FROM risk_reservations r
     WHERE r.user_id = $1
       AND EXISTS (SELECT 1 FROM positions p WHERE p.user_id = r.user_id AND p.pair_id = r.pair_id AND p.base_qty <> 0)`,
    [botUserId],
  );
  return Number(rows[0]!.total);
}

async function insertPendingProposal(pairId: string, entryPrice: string): Promise<string> {
  const stopPrice = (Number(entryPrice) * (1 - Number(STOP_DISTANCE_PCT))).toFixed(8);
  const targetPrice = (Number(entryPrice) * (1 + Number(STOP_DISTANCE_PCT) * 2)).toFixed(8);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  // agent_name is how this fixture is tagged for cleanupPriorRuns() --
  // 'concurrency-test' never collides with a real agent_name a live
  // Scanner/Chart Analysis run would ever write.
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO trade_proposals
       (pair_id, agent_name, timeframe, trade_type, side, entry_price, stop_price, target_price,
        confidence, entry_reason, stop_reason, target_reason, stop_distance_pct, expires_at)
     VALUES ($1, $2, '5m', 'swing', 'BUY', $3, $4, $5, 75, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      pairId, AGENT_NAME_TAG, entryPrice, stopPrice, targetPrice,
      "Synthetic fixture -- Track 2 concurrency test, not a real signal.",
      "Synthetic fixture -- Track 2 concurrency test, not a real signal.",
      "Synthetic fixture -- Track 2 concurrency test, not a real signal.",
      STOP_DISTANCE_PCT, expiresAt,
    ],
  );
  // qty is omitted (column stays NULL) -- migration 084 made it nullable
  // specifically so "not yet sized" is a real state; evaluateTradeProposal
  // computes its own qty and never reads the row's qty column at all
  // (see TradeProposalRow's SELECT list in evaluator.ts).
  return rows[0]!.id;
}

async function runTestA(botUserId: string, pairId: string, entryPrice: string): Promise<boolean> {
  console.log(`\n=== TEST A: Risk Agent exposure-cap race (N=${TEST_A_N}) ===`);

  const openRiskBefore = await currentOpenRisk(botUserId);
  const equity = Number((await getPortfolioSummary(botUserId, undefined, null)).equity_quote);
  const cap = equity * TOTAL_EXPOSURE_CAP_PCT;
  const perTrade = equity * RISK_PER_TRADE_PCT;
  const headroom = Math.max(0, cap - openRiskBefore);
  // +1e-9 epsilon guards against floating rounding landing just under an
  // integer boundary (e.g. 4.999999999 instead of 5) and off-by-one'ing
  // the floor.
  const expectedApproved = Math.min(TEST_A_N, Math.floor(headroom / perTrade + 1e-9));

  console.log(`  Bot equity: $${equity.toFixed(2)}  cap: $${cap.toFixed(2)}  open risk before: $${openRiskBefore.toFixed(2)}`);
  console.log(`  Expected approvals this batch: ${expectedApproved} (headroom $${headroom.toFixed(2)} / $${perTrade.toFixed(2)} per trade)`);

  const proposalIds: string[] = [];
  for (let i = 0; i < TEST_A_N; i++) {
    proposalIds.push(await insertPendingProposal(pairId, entryPrice));
  }

  const batchStart = performance.now();
  const calls = await Promise.all(
    proposalIds.map((id, i) => timed<RiskEvaluationResult>(i, batchStart, () => evaluateTradeProposal(id))),
  );

  const approved = calls.filter((c) => c.result?.decision === "approved");
  const rejectedCap = calls.filter(
    (c) => c.result?.decision === "rejected" && c.result.reason === "exposure_cap_exceeded",
  );
  const other = calls.filter((c) => !approved.includes(c) && !rejectedCap.includes(c));

  console.log(`  approved=${approved.length}  rejected(exposure_cap_exceeded)=${rejectedCap.length}  other=${other.length}`);
  if (other.length > 0) {
    console.log("  UNEXPECTED outcomes:", other.map((c) => ({ index: c.index, result: c.result, error: c.error })));
  }

  // Sum check: pull the actual committed risk_reservations rows for the
  // approved proposals and confirm their sum never exceeds the cap --
  // this is the DB-state proof, independent of trusting each call's own
  // returned riskAmountQuote (which could in principle be right per-call
  // but wrong in aggregate if two calls both computed against a stale
  // pre-lock read).
  const approvedIds = approved.map((c) => c.result!.proposalId);
  let reservedSum = 0;
  if (approvedIds.length > 0) {
    const { rows } = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(risk_amount_quote), 0) AS total FROM risk_reservations WHERE proposal_id = ANY($1)`,
      [approvedIds],
    );
    reservedSum = Number(rows[0]!.total);
  }
  const sumWithinCap = reservedSum <= cap + 1e-6; // epsilon for float/NUMERIC rounding
  console.log(`  risk_reservations sum for approved: $${reservedSum.toFixed(2)} (cap $${cap.toFixed(2)}) -- ${sumWithinCap ? "within cap" : "OVER CAP"}`);

  const pass =
    approved.length === expectedApproved &&
    rejectedCap.length === TEST_A_N - expectedApproved &&
    other.length === 0 &&
    sumWithinCap;

  console.log(
    pass
      ? "  PASS: advisory lock correctly serialized the exposure-cap check under real concurrency."
      : "  FAIL: exposure cap was raced or an unexpected outcome occurred -- see counts above.",
  );

  printTimings("Test A", calls);
  return pass;
}

const SNAPSHOT_POLL_INTERVAL_MS = 1500;
const SNAPSHOT_POLL_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls for a live (non-fallback) BTC/USD snapshot instead of a single
 * point-in-time check. This is a test-harness accommodation for a known,
 * documented system behavior, not a guess: the Kraken WS ticker connection
 * this snapshot depends on is confirmed (docs/followups.md, 2026-08-13
 * "Kraken WS connection instability") to go fully silent across all
 * subscribed symbols for 30+ second stretches on a recurring basis, so a
 * single check landing in one of those windows is a real, common outcome,
 * not a rare fluke worth treating as an immediate hard failure.
 */
async function checkLiveSnapshotOrAbort(botUserId: string, pairId: string): Promise<string> {
  const deadline = Date.now() + SNAPSHOT_POLL_TIMEOUT_MS;
  let attempts = 0;

  while (true) {
    attempts++;
    const snapshot = await resolveSnapshot(botUserId, pairId);
    if (snapshot.source !== "fallback") {
      console.log(`  Live snapshot OK (attempt ${attempts}): source=${snapshot.source} last=${snapshot.last} ts=${snapshot.ts}`);
      return snapshot.last;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Test B precondition failed: BTC/USD snapshot stayed source="fallback" for ${SNAPSHOT_POLL_TIMEOUT_MS}ms ` +
        `across ${attempts} attempts. This can be a real, documented Kraken WS gap (see docs/followups.md, ` +
        `"Kraken WS connection instability causing intermittent stale_price_source rejections") rather than a ` +
        `misconfigured environment -- check the dev server log for "[krakenWs] No ticks for 30s" before assuming ` +
        `REDIS_URL or the feed itself is misconfigured.`,
      );
    }

    console.log(`  Snapshot still fallback (attempt ${attempts}), retrying in ${SNAPSHOT_POLL_INTERVAL_MS}ms...`);
    await sleep(SNAPSHOT_POLL_INTERVAL_MS);
  }
}

async function insertApprovedProposal(pairId: string, entryPrice: string): Promise<string> {
  const stopPrice = (Number(entryPrice) * (1 - Number(STOP_DISTANCE_PCT))).toFixed(8);
  const targetPrice = (Number(entryPrice) * (1 + Number(STOP_DISTANCE_PCT) * 2)).toFixed(8);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  // Inserted directly as outcome='approved' -- skips Risk Agent entirely,
  // same as Test A skips Scanner/Chart Analysis. qty/stop_distance_pct are
  // populated here since runPhase1 requires both non-null on an approved
  // row (evaluator.ts would normally be what populates qty; we stand in
  // for it since this test targets Execution Agent specifically).
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO trade_proposals
       (pair_id, agent_name, timeframe, trade_type, side, entry_price, stop_price, target_price,
        qty, confidence, entry_reason, stop_reason, target_reason, stop_distance_pct, outcome, expires_at)
     VALUES ($1, $2, '5m', 'swing', 'BUY', $3, $4, $5, $11, 75, $6, $7, $8, $9, 'approved', $10)
     RETURNING id`,
    [
      pairId, AGENT_NAME_TAG, entryPrice, stopPrice, targetPrice,
      "Synthetic fixture -- Track 2 concurrency test, not a real signal.",
      "Synthetic fixture -- Track 2 concurrency test, not a real signal.",
      "Synthetic fixture -- Track 2 concurrency test, not a real signal.",
      STOP_DISTANCE_PCT, expiresAt, TEST_B_QTY,
    ],
  );
  return rows[0]!.id;
}

async function runTestB(botUserId: string, pairId: string): Promise<{ pass: boolean; proposalId: string }> {
  console.log(`\n=== TEST B: Execution Agent duplicate-order-on-redelivery (N=${TEST_B_N}) ===`);

  const entryPrice = await checkLiveSnapshotOrAbort(botUserId, pairId);
  // entry_price = the live snapshot's own "last" price -> delta is exactly
  // 0, so isWithinExecutionTolerance trivially passes regardless of its
  // exact tolerance formula. We want every call to reach the FOR UPDATE
  // lock / idempotency logic, not fail earlier on a stale-price rejection.
  const proposalId = await insertApprovedProposal(pairId, entryPrice);
  console.log(`  Synthetic approved proposal: ${proposalId} (entry=${entryPrice})`);

  const batchStart = performance.now();
  // All N calls target the SAME proposalId -- simulating an at-least-once
  // queue redelivering the same job N times, which is exactly the
  // scenario runPhase1's FOR UPDATE lock + outcome idempotency check
  // exists to make safe.
  const calls = await Promise.all(
    Array.from({ length: TEST_B_N }, (_, i) =>
      timed<ExecutionResult>(i, batchStart, () => executeTradeProposal(proposalId)),
    ),
  );

  const executed = calls.filter((c) => c.result?.outcome === "executed");
  const skipped = calls.filter((c) => c.result?.outcome === "skipped");
  const other = calls.filter((c) => !executed.includes(c) && !skipped.includes(c));

  console.log(`  executed=${executed.length}  skipped=${skipped.length}  other=${other.length}`);
  if (executed.length === 1) {
    console.log(`  orderId=${executed[0]!.result!.orderId}`);
  }
  if (skipped.length > 0) {
    const reasons = [...new Set(skipped.map((c) => c.result!.reason))];
    console.log(`  skip reason(s): ${reasons.join(", ")}`);
  }
  if (other.length > 0) {
    console.log("  UNEXPECTED outcomes:", other.map((c) => ({ index: c.index, result: c.result, error: c.error })));
  }

  const pass = executed.length === 1 && skipped.length === TEST_B_N - 1 && other.length === 0;
  console.log(
    pass
      ? "  PASS: FOR UPDATE row lock + idempotency correctly prevented a duplicate order under real concurrency."
      : "  FAIL: redelivery placed more than one order, or an unexpected outcome occurred -- see counts above.",
  );

  printTimings("Test B", calls);
  return { pass, proposalId };
}

async function flattenTestBPosition(botUserId: string, pairId: string, proposalId: string): Promise<boolean> {
  console.log("\n=== CLEANUP: flattening Test B's leftover BTC position ===");
  try {
    const result = await placeOrderWithSnapshot(
      botUserId,
      { pairId, side: "SELL", type: "MARKET", qty: TEST_B_QTY },
      `concurrency-test:flatten:${proposalId}`,
      undefined,
      null,
      null,
      "agent",
    );
    console.log(`  Flattened: SELL MARKET orderId=${result.order.id} qty=${TEST_B_QTY} -- bot account back to no open BTC/USD position.`);
    return true;
  } catch (err) {
    console.error(
      "  Flatten FAILED -- the bot account (riskagent@system.local) now holds an unflattened, UNPROTECTED " +
      `${TEST_B_QTY} BTC position with no stop/target triggers. This will read as real open exposure to any ` +
      "future real Risk Agent evaluation on this pair. Manual cleanup required:",
      err,
    );
    return false;
  }
}

async function main(): Promise<void> {
  console.log("=== Track 2: Agent Concurrency Test ===");
  console.log(`Config: TEST_A_N=${TEST_A_N} TEST_B_N=${TEST_B_N} STOP_DISTANCE_PCT=${STOP_DISTANCE_PCT}`);

  await ensureRiskAgentBotSetup();
  const botUserId = config.riskAgentBotUserId;
  const pairId = await getPairId();

  // Cleanup before Test A specifically -- Test A's expected-approval math
  // assumes a known starting open-risk baseline for this fixture's rows.
  // Must run before Test A, not just once at the top, for the same
  // reason: re-running the whole script twice in a row must not let wave
  // N's leftover reservations pollute wave N+1's headroom math.
  await cleanupPriorRuns();

  const { rows: pairRows } = await pool.query<{ last_price: string | null }>(
    `SELECT last_price FROM trading_pairs WHERE id = $1`,
    [pairId],
  );
  const entryPriceForTestA = pairRows[0]?.last_price ?? "43650.00000000";

  // Test A before Test B, always -- Test B is what opens a real bot
  // position, and Test A's exposure-cap math (via getTotalOpenRiskTx's
  // EXISTS-join to positions.base_qty <> 0) only stays predictable while
  // the bot holds no open BTC/USD position yet. Running Test B first
  // would make a second Test A run's expected-approved count depend on
  // whatever position size Test B happened to leave behind.
  const passA = await runTestA(botUserId, pairId, entryPriceForTestA);
  const { pass: passB, proposalId: testBProposalId } = await runTestB(botUserId, pairId);

  // Cleanup only runs after BOTH tests have reported, and only if Test B
  // passed cleanly -- if Test B did not pass, the actual leftover
  // position size is uncertain, and an automated flatten guessing at
  // TEST_B_QTY could overshoot into a short or partially close a
  // larger-than-expected position instead of fixing anything.
  let cleanupOk = true;
  if (passB) {
    cleanupOk = await flattenTestBPosition(botUserId, pairId, testBProposalId);
  } else {
    console.log("\n=== CLEANUP: skipped ===");
    console.log(
      "  Test B did not pass cleanly -- the actual leftover position size is uncertain, so an automated " +
      "flatten here could compound the problem. Inspect the bot's positions manually before trading against " +
      "this account again.",
    );
  }

  console.log("\n=== SUMMARY ===");
  console.log(`  Test A (exposure-cap race):           ${passA ? "PASS" : "FAIL"}`);
  console.log(`  Test B (duplicate-order redelivery):  ${passB ? "PASS" : "FAIL"}`);
  console.log(`  Cleanup (flatten Test B position):    ${passB ? (cleanupOk ? "OK" : "FAILED -- manual cleanup needed, see above") : "SKIPPED"}`);

  await pool.end();
  process.exitCode = passA && passB && cleanupOk ? 0 : 1;
}

main().catch(async (err) => {
  console.error("Script failed:", err);
  await pool.end();
  process.exitCode = 1;
});
