import http from 'k6/http';
import { check } from 'k6';

export const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:3001';

/**
 * Login a user and return an access token.
 * @param {string} email
 * @param {string} password
 * @returns {string} accessToken
 */
export function login(email, password) {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email, password }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  check(res, { 'login 200': (r) => r.status === 200 });
  const body = JSON.parse(res.body);
  if (!body.accessToken) {
    throw new Error(`Login failed for ${email}: status=${res.status} body=${res.body}`);
  }
  return body.accessToken;
}

/**
 * Build Fastify-compatible auth + content-type headers.
 * @param {string} token
 * @returns {{ headers: object }}
 */
export function authHeaders(token) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
}

/**
 * GET an authenticated endpoint.
 * @param {string} token
 * @param {string} path  e.g. '/wallets'
 * @returns {Response}
 */
export function authedGet(token, path) {
  return http.get(`${BASE_URL}${path}`, authHeaders(token));
}

/**
 * POST JSON to an authenticated endpoint.
 * @param {string} token
 * @param {string} path
 * @param {object} body
 * @returns {Response}
 */
export function authedPost(token, path, body) {
  return http.post(
    `${BASE_URL}${path}`,
    JSON.stringify(body),
    authHeaders(token)
  );
}

/**
 * DELETE to an authenticated endpoint.
 * @param {string} token
 * @param {string} path
 * @returns {Response}
 */
export function authedDelete(token, path) {
  return http.del(`${BASE_URL}${path}`, null, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * Login all users from the seed manifest sequentially.
 * Intended for use in k6 setup() — runs once before VUs start.
 * DISABLE_RATE_LIMIT=true must be set on the server.
 * @param {{ users: Array<{email: string, password: string}> }} manifest
 * @returns {string[]} accessTokens indexed by user order
 */
export function loginAllUsers(manifest) {
  const tokens = [];
  for (const u of manifest.users) {
    const token = login(u.email, u.password);
    tokens.push(token);
  }
  return tokens;
}
