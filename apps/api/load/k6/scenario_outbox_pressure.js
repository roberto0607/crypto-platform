import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Gauge } from 'k6/metrics';
import { authedPost, loginAllUsers, BASE_URL } from './common.js';

const manifest = JSON.parse(open('./seed-manifest.json'));

const outboxOrderMs = new Trend('outbox_order_ms', true);
// Mirror outbox_queue_depth Prometheus gauge as a k6 metric for the summary report
const outboxQueueDepth = new Gauge('k6_outbox_queue_depth');

export const options = {
  scenarios: {
    // 5 VUs continuously placing MARKET orders
    order_writers: {
      executor: 'constant-vus',
      vus: 5,
      duration: '60s',
      exec: 'placeOrders',
    },
    // 1 VU polling /metrics every 2s and recording outbox_queue_depth
    metrics_poller: {
      executor: 'constant-vus',
      vus: 1,
      duration: '60s',
      exec: 'pollMetrics',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    outbox_order_ms: ['p(95)<500'],
  },
};

export function setup() {
  const tokens = loginAllUsers(manifest);
  return { tokens, pairId: manifest.pairId };
}

export function placeOrders(data) {
  // Rotate through all available users randomly to stay under per-user rate limits
  const token = data.tokens[Math.floor(Math.random() * data.tokens.length)];
  const pairId = data.pairId;

  const res = authedPost(token, '/orders', {
    pairId,
    side: 'BUY',
    type: 'MARKET',
    qty: '0.001',
  });
  check(res, { 'order 201': (r) => r.status === 201 });
  outboxOrderMs.add(res.timings.duration);

  sleep(0.2);
}

export function pollMetrics() {
  const res = http.get(`${BASE_URL}/metrics`);
  if (res.status === 200) {
    // Parse outbox_queue_depth value from Prometheus text format
    const match = res.body.match(/^outbox_queue_depth\s+([\d.]+)/m);
    if (match) {
      outboxQueueDepth.add(parseFloat(match[1]));
    }
  }
  sleep(2);
}
