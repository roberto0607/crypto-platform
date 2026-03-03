import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { authedGet, loginAllUsers } from './common.js';

const manifest = JSON.parse(open('./seed-manifest.json'));

// Custom trend to track read latency separately from k6's built-in http_req_duration
const readLatencyMs = new Trend('read_latency_ms', true);

export const options = {
  vus: 20,
  duration: '60s',
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.005'],
    // Baseline SLO target for reads
    read_latency_ms: ['p(95)<150'],
  },
};

export function setup() {
  const tokens = loginAllUsers(manifest);
  return { tokens, pairId: manifest.pairId };
}

export default function (data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const pairId = data.pairId;

  let res;

  res = authedGet(token, '/pairs');
  check(res, { 'GET /pairs 200': (r) => r.status === 200 });
  readLatencyMs.add(res.timings.duration);

  res = authedGet(token, `/pairs/${pairId}/book?levels=10`);
  check(res, { 'GET /pairs/:id/book 200': (r) => r.status === 200 });
  readLatencyMs.add(res.timings.duration);

  res = authedGet(token, '/wallets');
  check(res, { 'GET /wallets 200': (r) => r.status === 200 });
  readLatencyMs.add(res.timings.duration);

  res = authedGet(token, '/positions');
  check(res, { 'GET /positions 200': (r) => r.status === 200 });
  readLatencyMs.add(res.timings.duration);

  res = authedGet(token, '/pnl/summary');
  check(res, { 'GET /pnl/summary 200': (r) => r.status === 200 });
  readLatencyMs.add(res.timings.duration);

  sleep(0.5);
}
