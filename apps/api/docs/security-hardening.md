# Security Hardening — Phase 10 PR7

## Overview

This document describes the security controls added to prepare the backend for public internet exposure.

## 1. API Key Infrastructure

- **Storage**: Raw keys are never stored. Only SHA-256 hashes are persisted in `api_keys.key_hash`.
- **Prefix**: All keys use the `cpk_` prefix (crypto-platform key) for identification.
- **Entropy**: 32 random bytes (256 bits) — infeasible to brute force.
- **Comparison**: Constant-time via `crypto.timingSafeEqual` to prevent timing side-channel attacks.
- **Scopes**: `read`, `trade`, `admin`. Admin implies all scopes.
- **Expiry**: Optional `expires_at` field. Expired keys are rejected at validation time.
- **Revocation**: Instant via `POST /api-keys/:id/revoke`. Revoked keys are rejected at lookup.
- **last_used_at**: Updated on each successful authentication (fire-and-forget).

### Auth Flow

```
Authorization: Bearer <jwt>   → existing JWT flow (unchanged)
Authorization: ApiKey <rawKey> → API key validation + scope enforcement
```

- API keys authenticate as `role: "USER"` regardless of the owning user's role.
- API keys cannot access admin routes (`requireRole("ADMIN")` blocks them).
- API keys cannot create or revoke other API keys (JWT-only operations).

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api-keys | JWT | Create key (returns rawKey once) |
| GET | /api-keys | JWT or ApiKey | List user's keys (no hashes) |
| POST | /api-keys/:id/revoke | JWT | Revoke a key |

## 2. Login Abuse Protection

- **Table**: `login_attempts` records every login attempt (email, IP, success, timestamp).
- **Window**: Configurable via `LOGIN_BLOCK_WINDOW_MINUTES` (default: 15).
- **Thresholds**:
  - Per email: `MAX_LOGIN_ATTEMPTS_PER_EMAIL` (default: 5)
  - Per IP: `MAX_LOGIN_ATTEMPTS_PER_IP` (default: 20)
- **Reset**: Successful login resets the effective window (failures before last success are ignored).
- **Response**: `HTTP 429` with `{ error: { code: "LOGIN_BLOCKED", message: "Too many failed login attempts." } }`.
- **DB-backed**: Survives server restarts (unlike in-memory counters).

## 3. API Key Rate Limiting

- **Implementation**: In-memory sliding window per API key ID.
- **Limit**: `MAX_API_KEY_REQ_PER_MIN` (default: 120).
- **Window**: 60 seconds (fixed).
- **Response**: `HTTP 429` with `{ error: { code: "API_KEY_RATE_LIMIT", message: "API key rate limit exceeded." } }`.
- **Note**: Resets on server restart (acceptable for paper trading).

## 4. Suspicious Activity Detection

- **Cancel/replace burst**: Tracks cancel/replace events per user in a sliding window.
  - Threshold: `SUSPICIOUS_CANCEL_BURST_THRESHOLD` (default: 15)
  - Window: `SUSPICIOUS_ORDER_WINDOW_MS` (default: 10,000ms)
- **Order burst**: Existing `burstDetector.ts` tracks rapid order placement.
  - Threshold: `MAX_ORDER_BURST` (default: 20)
  - Window: `ORDER_BURST_WINDOW_MS` (default: 5,000ms)
- **Action**: Disables user trading (`user_quotas.trading_enabled = false`), writes audit log, increments `suspicious_activity_total` metric.
- **Recovery**: Admin re-enables via `POST /v1/admin/users/:id/quotas { trading_enabled: true }`.

## 5. Security Headers

Configured via `@fastify/helmet`:

| Header | Value |
|--------|-------|
| X-Frame-Options | DENY |
| X-Content-Type-Options | nosniff |
| Referrer-Policy | strict-origin-when-cross-origin |
| X-Powered-By | removed |
| Content-Security-Policy | disabled (API-only, no HTML) |

## 6. CORS

- Origins: `CORS_ORIGINS` env var (comma-separated), defaults to `localhost:5173,3000`.
- Credentials: enabled.
- Allowed headers: `Content-Type`, `Authorization`, `Idempotency-Key`, `X-Request-Id`, `X-Api-Key`.

## 7. Metrics

| Metric | Type | Description |
|--------|------|-------------|
| api_key_created_total | Counter | API keys created |
| api_key_revoked_total | Counter | API keys revoked |
| api_key_auth_total | Counter | Successful API key authentications |
| login_blocked_total | Counter | Login attempts blocked by abuse protection |
| api_key_rate_limited_total | Counter | Requests rejected by API key rate limiter |
| suspicious_activity_total | Counter | Users flagged for suspicious activity |

## 8. Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| MAX_LOGIN_ATTEMPTS_PER_EMAIL | 5 | Failed logins per email before block |
| MAX_LOGIN_ATTEMPTS_PER_IP | 20 | Failed logins per IP before block |
| LOGIN_BLOCK_WINDOW_MINUTES | 15 | Sliding window for login protection |
| MAX_API_KEY_REQ_PER_MIN | 120 | Per-key rate limit |
| SUSPICIOUS_CANCEL_BURST_THRESHOLD | 15 | Cancel/replace events before flag |
| SUSPICIOUS_ORDER_WINDOW_MS | 10000 | Window for cancel/replace detection |
