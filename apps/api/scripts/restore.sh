#!/usr/bin/env bash
set -euo pipefail

# restore.sh — Restore a pg_dump backup to a new named database.
#
# Usage:
#   DATABASE_URL=<url> RESTORE_DB_NAME=<name> bash scripts/restore.sh <backup_file> [--force]
#
# Arguments:
#   <backup_file>   Path to the .dump file (required)
#   --force         Drop and recreate RESTORE_DB_NAME if it already exists
#
# Environment:
#   DATABASE_URL       Required.
#   RESTORE_DB_NAME    Required. Target DB to create and restore into.

BACKUP_FILE="${1:?Usage: restore.sh <backup_file> [--force]}"
FORCE=false
if [[ "${2:-}" == "--force" ]]; then
  FORCE=true
fi

DATABASE_URL="${DATABASE_URL:?Missing DATABASE_URL}"
RESTORE_DB_NAME="${RESTORE_DB_NAME:?Missing RESTORE_DB_NAME}"

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "[restore] ERROR: Backup file not found: ${BACKUP_FILE}"
  exit 1
fi

# Parse connection params from DATABASE_URL
# Expects: postgresql://user:password@host:port/dbname
PG_USER=$(echo "$DATABASE_URL"     | sed -E 's|postgresql://([^:]+):.*|\1|')
PG_PASSWORD=$(echo "$DATABASE_URL" | sed -E 's|postgresql://[^:]+:([^@]+)@.*|\1|')
PG_HOST=$(echo "$DATABASE_URL"     | sed -E 's|.*@([^:/]+).*|\1|')
PG_PORT=$(echo "$DATABASE_URL"     | sed -E 's|.*:([0-9]+)/[^/]*$|\1|')

export PGPASSWORD="$PG_PASSWORD"

# Check if target DB exists
DB_EXISTS=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='${RESTORE_DB_NAME}';" 2>/dev/null || echo "")

if [[ "$DB_EXISTS" == "1" ]]; then
  if [[ "$FORCE" == "true" ]]; then
    echo "[restore] Dropping existing database: ${RESTORE_DB_NAME}"
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -c \
      "DROP DATABASE IF EXISTS \"${RESTORE_DB_NAME}\";"
  else
    echo "[restore] ERROR: Database '${RESTORE_DB_NAME}' already exists. Use --force to overwrite."
    exit 1
  fi
fi

echo "[restore] Creating database: ${RESTORE_DB_NAME}"
createdb -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" "$RESTORE_DB_NAME"

echo "[restore] Restoring from: ${BACKUP_FILE}"
pg_restore \
  --host="$PG_HOST" \
  --port="$PG_PORT" \
  --username="$PG_USER" \
  --dbname="$RESTORE_DB_NAME" \
  --no-owner \
  --no-privileges \
  "${BACKUP_FILE}"

# Verification summary
MIGRATION_COUNT=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$RESTORE_DB_NAME" \
  -tAc "SELECT COUNT(*) FROM schema_migrations;" 2>/dev/null || echo "0")

LATEST_MIGRATION=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$RESTORE_DB_NAME" \
  -tAc "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1;" 2>/dev/null || echo "NONE")

echo ""
echo "[restore] ─────────────────────────────────────────"
echo "[restore] Restore Summary"
echo "[restore] ─────────────────────────────────────────"
echo "[restore] Target DB:          ${RESTORE_DB_NAME}"
echo "[restore] Backup file:        ${BACKUP_FILE}"
echo "[restore] Migrations applied: ${MIGRATION_COUNT}"
echo "[restore] Latest migration:   ${LATEST_MIGRATION}"
echo "[restore] ─────────────────────────────────────────"
echo "[restore] DONE"
