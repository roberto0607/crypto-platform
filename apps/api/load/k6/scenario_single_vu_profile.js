import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { authedPost, authedDelete, loginAllUsers } from './common.js';

const manifest = JSON.parse(open('./seed-manifest.json'));

// Kept separate from the aggregate trade_burst metric so MARKET (real
// matching/system-fill work) and LIMIT (reserve + rest, no fill work here)
// costs aren't blended together.
const marketOrderMs = new Trend('market_order_placement_ms', true);
const limitOrderMs = new Trend('limit_order_placement_ms', true);
const orderCancelMs = new Trend('order_cancel_ms', true);

// Fill-type breakdown — the thing this run exists to capture, per the
// book-depth-vs-per-order-cost hypothesis.
const fillsBookMatched = new Counter('fills_book_matched_total');
const fillsSystemFill = new Counter('fills_system_fill_total');
const marketOrdersWithZeroFills = new Counter('market_orders_zero_fills_total');

export const options = {
  vus: 1,
  iterations: __ENV.ITERATIONS ? parseInt(__ENV.ITERATIONS, 10) : 80,
  // No thresholds — this run is for raw measurement, not pass/fail.
};

export function setup() {
  const tokens = loginAllUsers(manifest);
  return { tokens, pairId: manifest.pairId };
}

export default function (data) {
  // vus=1 -> always tokens[0] -> single user, sequential, no cross-user variance.
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const pairId = data.pairId;

  // 1. MARKET BUY — matches resting asks first, falls through to a system
  //    fill against pair.last_price for any unfilled remainder.
  const marketRes = authedPost(token, '/orders', {
    pairId,
    side: 'BUY',
    type: 'MARKET',
    qty: '0.001',
  });
  check(marketRes, {
    'POST /orders MARKET 201': (r) => r.status === 201,
  });
  marketOrderMs.add(marketRes.timings.duration);

  if (marketRes.status === 201) {
    const body = JSON.parse(marketRes.body);
    const fills = body.fills || [];
    if (fills.length === 0) {
      marketOrdersWithZeroFills.add(1);
    }
    for (const fill of fills) {
      if (fill.is_system_fill) {
        fillsSystemFill.add(1);
      } else {
        fillsBookMatched.add(1);
      }
    }
  }

  // 2. LIMIT BUY far below market — rests on book without filling.
  const limitRes = authedPost(token, '/orders', {
    pairId,
    side: 'BUY',
    type: 'LIMIT',
    qty: '0.001',
    limitPrice: '30000.00000000',
  });
  check(limitRes, {
    'POST /orders LIMIT 201': (r) => r.status === 201,
  });
  limitOrderMs.add(limitRes.timings.duration);

  // 3. Cancel the resting LIMIT order — keeps book depth from growing across
  //    iterations so every MARKET order sees comparable resting-order state.
  if (limitRes.status === 201) {
    const limitBody = JSON.parse(limitRes.body);
    const orderId = limitBody.order && limitBody.order.id;
    if (orderId) {
      const cancelRes = authedDelete(token, `/orders/${orderId}`);
      check(cancelRes, {
        'DELETE /orders/:id 200': (r) => r.status === 200,
      });
      orderCancelMs.add(cancelRes.timings.duration);
    }
  }

  // No sleep() — single VU, back-to-back, zero intentional pacing.
}
