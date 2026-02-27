# API v1 Contracts

## Versioning

All v1 endpoints are mounted under the `/v1` prefix. Legacy routes remain unchanged at their original paths.

- **v1 routes**: `/v1/orders`, `/v1/wallets/:id/transactions`, `/v1/equity`, `/v1/pairs`
- **Legacy routes**: `/orders`, `/wallets/:id/transactions`, `/equity`, `/pairs`

Legacy routes will not be removed but are frozen — no new features will be added to them.

## Authentication

All v1 endpoints require a valid JWT access token:

```
Authorization: Bearer <accessToken>
```

Unauthenticated requests receive HTTP 401.

## Error Envelope

All v1 error responses use a standard envelope:

```json
{
  "code": "order_not_found",
  "message": "The requested order was not found.",
  "details": null,
  "requestId": "req-1"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `code` | `string` | Machine-readable error code (stable, safe to switch on) |
| `message` | `string` | Human-readable description |
| `details` | `any?` | Optional structured details (e.g. validation errors) |
| `requestId` | `string` | Fastify-generated request ID for tracing |

Known error codes: `invalid_input`, `insufficient_balance`, `no_price_available`, `order_not_cancelable`, `invalid_credentials`, `unauthorized`, `forbidden`, `user_not_found`, `asset_not_found`, `wallet_not_found`, `order_not_found`, `pair_not_found`, `email_taken`, `wallet_already_exists`, `asset_already_exists`, `pair_already_exists`, `role_unchanged`, `risk_check_failed`, `server_error`.

## Pagination

List endpoints use cursor-based (keyset) pagination.

### Query Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | `number` | `25` | Items per page. Min 1, max 100. |
| `cursor` | `string` | — | Opaque cursor from a previous `nextCursor` response. |

### Response Envelope

```json
{
  "data": [ ... ],
  "nextCursor": "eyJjYSI6Ii4uLiIsImlkIjoiLi4uIn0" | null
}
```

- `data`: Array of items for the current page.
- `nextCursor`: Opaque string to fetch the next page. `null` when there are no more results.

### Cursor Format (internal)

Cursors are base64url-encoded JSON. Clients must treat them as opaque strings.

- **Orders / Transactions**: `{ "ca": "<ISO timestamp>", "id": "<UUID>" }` — keyset on `(created_at, id)`.
- **Equity**: `{ "ts": <epoch_int> }` — keyset on `ts`.

## Endpoints

### GET /v1/orders

List the authenticated user's orders, newest first.

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `pairId` | `uuid?` | Filter by trading pair |
| `status` | `string?` | Filter by status (`OPEN`, `PARTIALLY_FILLED`, `FILLED`, `CANCELED`, `REJECTED`) |
| `limit` | `number?` | Page size (1–100, default 25) |
| `cursor` | `string?` | Pagination cursor |

**Response 200:**

```json
{
  "data": [
    {
      "id": "uuid",
      "user_id": "uuid",
      "pair_id": "uuid",
      "side": "BUY",
      "type": "LIMIT",
      "limit_price": "49000.00000000",
      "qty": "0.10000000",
      "qty_filled": "0.00000000",
      "status": "OPEN",
      "reserved_wallet_id": "uuid",
      "reserved_amount": "4900.00000000",
      "reserved_consumed": "0.00000000",
      "created_at": "2025-01-15T10:30:00.000Z",
      "updated_at": "2025-01-15T10:30:00.000Z"
    }
  ],
  "nextCursor": "eyJjYSI6Ii4uLiIsImlkIjoiLi4uIn0"
}
```

**Ordering:** `created_at DESC, id DESC`

---

### GET /v1/wallets/:id/transactions

List ledger entries for a wallet owned by the authenticated user.

**Path Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `id` | `uuid` | Wallet ID |

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `limit` | `number?` | Page size (1–100, default 25) |
| `cursor` | `string?` | Pagination cursor |

**Response 200:**

```json
{
  "data": [
    {
      "id": "uuid",
      "wallet_id": "uuid",
      "entry_type": "DEPOSIT",
      "amount": "1000.00000000",
      "balance_after": "1000.00000000",
      "reference_id": null,
      "reference_type": null,
      "metadata": {},
      "created_at": "2025-01-15T10:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

**Ordering:** `created_at DESC, id DESC`

**Errors:** `403 forbidden` (not owner), `404 wallet_not_found`

---

### GET /v1/equity

List equity snapshots for the authenticated user, oldest first.

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `from` | `number?` | Inclusive lower bound (epoch integer) |
| `to` | `number?` | Inclusive upper bound (epoch integer) |
| `limit` | `number?` | Page size (1–100, default 25) |
| `cursor` | `string?` | Pagination cursor |

**Response 200:**

```json
{
  "data": [
    { "ts": "1700000000", "equity_quote": "100000.00000000" },
    { "ts": "1700003600", "equity_quote": "100150.00000000" }
  ],
  "nextCursor": "eyJ0cyI6MTcwMDAwMzYwMH0"
}
```

**Ordering:** `ts ASC`

---

### GET /v1/pairs

List active trading pairs.

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `limit` | `number?` | Max items (1–100, default 25) |

**Response 200:**

```json
{
  "data": [
    {
      "id": "uuid",
      "base_asset_id": "uuid",
      "quote_asset_id": "uuid",
      "symbol": "BTC-USD",
      "is_active": true,
      "last_price": "50000.00000000",
      "fee_bps": 30,
      "maker_fee_bps": 2,
      "taker_fee_bps": 5,
      "created_at": "2025-01-01T00:00:00.000Z",
      "updated_at": "2025-01-15T10:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

**Ordering:** `symbol ASC`

**Note:** `nextCursor` is always `null` for pairs (small bounded set, no cursor pagination).

## Stability Guarantees

- Response shapes for v1 endpoints will not change in backwards-incompatible ways.
- New optional fields may be added to response objects.
- New optional query parameters may be added.
- Error codes are stable and can be used for programmatic matching.
- Cursor format is opaque — do not parse or construct cursors manually.
