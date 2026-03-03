import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { authedGet, authedPost, loginAllUsers } from './common.js';

const manifest = JSON.parse(open('./seed-manifest.json'));

const writeLatencyMs = new Trend('write_latency_ms', true);
const readLatencyMs = new Trend('read_latency_ms', true);

export const options = {
  vus: 15,
  duration: '90s',
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
    write_latency_ms: ['p(95)<250'],
    read_latency_ms: ['p(95)<150'],
  },
};

export function setup() {
  const tokens = loginAllUsers(manifest);
  return { tokens, pairId: manifest.pairId };
}

// Static read paths (no pairId required)
const STATIC_READS = ['/pairs', '/wallets', '/positions', '/pnl/summary'];

export default function (data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const pairId = data.pairId;

  const roll = Math.random();

  if (roll < 0.70) {
    // 70% reads — rotate across all read endpoints including book + snapshot
    const readRoll = Math.random();
    let path;
    if (readRoll < 0.25) {
      path = `/pairs/${pairId}/book?levels=10`;
    } else if (readRoll < 0.45) {
      path = `/pairs/${pairId}/snapshot`;
    } else {
      path = STATIC_READS[Math.floor(Math.random() * STATIC_READS.length)];
    }
    const res = authedGet(token, path);
    check(res, { 'read 200': (r) => r.status === 200 });
    readLatencyMs.add(res.timings.duration);
  } else {
    // 30% writes — MARKET BUY small qty
    const res = authedPost(token, '/orders', {
      pairId,
      side: 'BUY',
      type: 'MARKET',
      qty: '0.001',
    });
    check(res, {
      'write 201': (r) => r.status === 201,
      'write ok': (r) => JSON.parse(r.body).ok === true,
    });
    writeLatencyMs.add(res.timings.duration);
  }

  sleep(0.3);
}
