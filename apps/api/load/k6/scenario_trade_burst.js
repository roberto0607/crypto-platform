import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { authedPost, authedDelete, loginAllUsers } from './common.js';

const manifest = JSON.parse(open('./seed-manifest.json'));

const orderPlacementMs = new Trend('order_placement_ms', true);
const orderCancelMs = new Trend('order_cancel_ms', true);

export const options = {
  vus: 10,
  duration: '60s',
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
    // Baseline SLO target from spec
    order_placement_ms: ['p(95)<250'],
  },
};

export function setup() {
  const tokens = loginAllUsers(manifest);
  return { tokens, pairId: manifest.pairId };
}

export default function (data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const pairId = data.pairId;

  // 1. MARKET BUY — executes immediately or fills from resting asks
  const marketRes = authedPost(token, '/orders', {
    pairId,
    side: 'BUY',
    type: 'MARKET',
    qty: '0.001',
  });
  check(marketRes, {
    'POST /orders MARKET 201': (r) => r.status === 201,
    'MARKET order ok': (r) => JSON.parse(r.body).ok === true,
  });
  orderPlacementMs.add(marketRes.timings.duration);

  // 2. LIMIT BUY far below market — will rest on book without filling
  const limitRes = authedPost(token, '/orders', {
    pairId,
    side: 'BUY',
    type: 'LIMIT',
    qty: '0.001',
    limitPrice: '30000.00000000',
  });
  check(limitRes, {
    'POST /orders LIMIT 201': (r) => r.status === 201,
    'LIMIT order ok': (r) => JSON.parse(r.body).ok === true,
  });
  orderPlacementMs.add(limitRes.timings.duration);

  // 3. Cancel the resting LIMIT order
  if (limitRes.status === 201) {
    const limitBody = JSON.parse(limitRes.body);
    const orderId = limitBody.order && limitBody.order.id;
    if (orderId) {
      const cancelRes = authedDelete(token, `/orders/${orderId}`);
      check(cancelRes, {
        'DELETE /orders/:id 200': (r) => r.status === 200,
        'cancel ok': (r) => JSON.parse(r.body).ok === true,
      });
      orderCancelMs.add(cancelRes.timings.duration);
    }
  }

  sleep(1);
}
