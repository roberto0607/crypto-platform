import { check, sleep } from 'k6';
import { authedGet, loginAllUsers } from './common.js';

// open() is evaluated once per VU during k6 init phase
const manifest = JSON.parse(open('./seed-manifest.json'));

export const options = {
  vus: 5,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

// setup() runs once before all VUs; returned value is passed to default()
export function setup() {
  const tokens = loginAllUsers(manifest);
  return { tokens };
}

// Each VU receives the shared data object from setup()
export default function (data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];

  const res = authedGet(token, '/auth/me');
  check(res, {
    'GET /auth/me 200': (r) => r.status === 200,
    'GET /auth/me ok:true': (r) => JSON.parse(r.body).ok === true,
  });

  sleep(0.5);
}
