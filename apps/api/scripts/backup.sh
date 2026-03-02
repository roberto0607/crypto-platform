#!/usr/bin/env bash
set -euo pipefail

# backup.sh — Create a pg_dump backup of the database.
#
# Usage:
#   DATABASE_URL=<url> bash scripts/backup.sh
#
# Environment:
#   DATABASE_URL             Required. PostgreSQL connection string.
#   BACKUP_DIR               Optional. Default: ./backups
#   BACKUP_RETENTION_DAYS    Optional. Default: 14

DATABASE_URL="${DATABASE_URL:?Missing DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILENAME="backup_${TIMESTAMP}.dump"
FILEPATH="${BACKUP_DIR}/${FILENAME}"

echo "[backup] Starting backup → ${FILEPATH}"

pg_dump --format=custom --file="${FILEPATH}" "${DATABASE_URL}"

SIZE_BYTES=$(wc -c < "${FILEPATH}" | tr -d ' ')

echo "[backup] Backup complete. Size: ${SIZE_BYTES} bytes."

# Record in backup_metadata
psql "${DATABASE_URL}" -q -c \
  "INSERT INTO backup_metadata (filename, size_bytes) VALUES ('${FILENAME}', ${SIZE_BYTES});"

echo "[backup] Metadata recorded."

# Cleanup old backups
echo "[backup] Cleaning up backups older than ${BACKUP_RETENTION_DAYS} days..."
find "${BACKUP_DIR}" -name "backup_*.dump" -mtime "+${BACKUP_RETENTION_DAYS}" -delete

echo "[backup] Done."
