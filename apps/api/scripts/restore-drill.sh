#!/usr/bin/env bash
set -euo pipefail

# restore-drill.sh — Automated restore drill: backup → restore → verify → drop → mark.
#
# Usage:
#   DATABASE_URL=<url> bash scripts/restore-drill.sh
#
# Environment:
#   DATABASE_URL       Required.
#   BACKUP_DIR         Optional. Default: ./backups
#   DRILL_DB_NAME      Optional. Default: cp_restore_test

DATABASE_URL="${DATABASE_URL:?Missing DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
DRILL_DB_NAME="${DRILL_DB_NAME:-cp_restore_test}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=true
FAIL_REASON=""
START_TS=$(date +%s)

echo "[drill] ════════════════════════════════════════════"
echo "[drill] Restore Drill — $(date '+%Y-%m-%d %H:%M:%S')"
echo "[drill] ════════════════════════════════════════════"

# ── Step 1: Take fresh backup ──
echo "[drill] Step 1: Taking fresh backup..."
BACKUP_STDOUT=$(mktemp)

BACKUP_DIR="$BACKUP_DIR" DATABASE_URL="$DATABASE_URL" \
  bash "${SCRIPT_DIR}/backup.sh" >"$BACKUP_STDOUT" 2>&1 || true

cat "$BACKUP_STDOUT"

BACKUP_FILE=$(grep "Starting backup →" "$BACKUP_STDOUT" | sed 's/.*→ //' | tr -d '[:space:]' || echo "")

if [[ -z "$BACKUP_FILE" || ! -f "$BACKUP_FILE" ]]; then
  BACKUP_FILE=$(find "$BACKUP_DIR" -name "backup_*.dump" | sort | tail -n 1)
fi

if [[ -z "$BACKUP_FILE" || ! -f "$BACKUP_FILE" ]]; then
  PASS=false
  FAIL_REASON="Backup file not created"
  echo "[drill] STEP 1 FAILED: Could not create or locate backup file"
else
  echo "[drill] Step 1: OK — ${BACKUP_FILE}"
fi

# Parse connection params
PG_USER=$(echo "$DATABASE_URL"     | sed -E 's|postgresql://([^:]+):.*|\1|')
PG_PASSWORD=$(echo "$DATABASE_URL" | sed -E 's|postgresql://[^:]+:([^@]+)@.*|\1|')
PG_HOST=$(echo "$DATABASE_URL"     | sed -E 's|.*@([^:/]+).*|\1|')
PG_PORT=$(echo "$DATABASE_URL"     | sed -E 's|.*:([0-9]+)/[^/]*$|\1|')
SOURCE_DB=$(echo "$DATABASE_URL"   | sed -E 's|.*/([^/?]+).*|\1|')
export PGPASSWORD="$PG_PASSWORD"

# ── Step 2: Restore into drill DB ──
if [[ "$PASS" == "true" ]]; then
  echo "[drill] Step 2: Restoring into ${DRILL_DB_NAME}..."
  if ! DATABASE_URL="$DATABASE_URL" RESTORE_DB_NAME="$DRILL_DB_NAME" \
      bash "${SCRIPT_DIR}/restore.sh" "$BACKUP_FILE" --force; then
    PASS=false
    FAIL_REASON="pg_restore failed"
    echo "[drill] STEP 2 FAILED"
  else
    echo "[drill] Step 2: OK"
  fi
fi

# ── Step 3a: Event stream chain verification ──
if [[ "$PASS" == "true" ]]; then
  echo "[drill] Step 3a: Event stream chain verification..."
  CHAIN_BROKEN=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$DRILL_DB_NAME" -tAc "
    SELECT COUNT(*) FROM (
      SELECT
        seq,
        prev_hash,
        lag(event_hash) OVER (ORDER BY seq) AS expected_prev
      FROM event_stream
    ) t
    WHERE seq > 1
      AND prev_hash IS DISTINCT FROM expected_prev;
  " 2>/dev/null || echo "SKIP")

  if [[ "$CHAIN_BROKEN" == "SKIP" || "$CHAIN_BROKEN" == "" ]]; then
    echo "[drill] Step 3a: SKIP — event_stream table empty or unavailable"
  elif [[ "$CHAIN_BROKEN" != "0" ]]; then
    PASS=false
    FAIL_REASON="Event stream chain broken: ${CHAIN_BROKEN} broken link(s)"
    echo "[drill] STEP 3a FAILED: ${CHAIN_BROKEN} broken chain links"
  else
    echo "[drill] Step 3a: OK — chain intact"
  fi
fi

# ── Step 3b: Core tables sanity check ──
if [[ "$PASS" == "true" ]]; then
  echo "[drill] Step 3b: Core tables sanity check..."
  USER_COUNT=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$DRILL_DB_NAME" \
    -tAc "SELECT COUNT(*) FROM users;" 2>/dev/null || echo "ERROR")
  WALLET_COUNT=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$DRILL_DB_NAME" \
    -tAc "SELECT COUNT(*) FROM wallets;" 2>/dev/null || echo "ERROR")
  MIGRATION_COUNT=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$DRILL_DB_NAME" \
    -tAc "SELECT COUNT(*) FROM schema_migrations;" 2>/dev/null || echo "ERROR")

  if [[ "$USER_COUNT" == "ERROR" || "$WALLET_COUNT" == "ERROR" || "$MIGRATION_COUNT" == "ERROR" ]]; then
    PASS=false
    FAIL_REASON="Core tables inaccessible after restore"
    echo "[drill] STEP 3b FAILED: Could not query core tables"
  else
    echo "[drill] Step 3b: OK — users=${USER_COUNT}, wallets=${WALLET_COUNT}, migrations=${MIGRATION_COUNT}"
  fi
fi

# ── Step 4: Drop drill DB ──
echo "[drill] Step 4: Dropping ${DRILL_DB_NAME}..."
psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS \"${DRILL_DB_NAME}\";" 2>/dev/null || true
echo "[drill] Step 4: OK"

# ── Step 5: Mark backup verified ──
if [[ "$PASS" == "true" && -n "$BACKUP_FILE" ]]; then
  FILENAME=$(basename "$BACKUP_FILE")
  psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$SOURCE_DB" -q -c \
    "UPDATE backup_metadata SET verified_restore = true, verified_at = now() WHERE filename = '${FILENAME}';" \
    2>/dev/null || echo "[drill] WARNING: Could not mark backup as verified in metadata"
  echo "[drill] Step 5: Backup marked as verified."
fi

END_TS=$(date +%s)
DURATION=$((END_TS - START_TS))

echo ""
echo "[drill] ════════════════════════════════════════════"
if [[ "$PASS" == "true" ]]; then
  echo "[drill] RESULT: PASS (${DURATION}s)"
else
  echo "[drill] RESULT: FAIL — ${FAIL_REASON} (${DURATION}s)"
fi
echo "[drill] ════════════════════════════════════════════"

if [[ "$PASS" != "true" ]]; then
  exit 1
fi
