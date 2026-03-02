# Disaster Recovery Runbook

## Overview

This runbook documents the backup, restore, and restore-drill procedures for the
crypto-platform API database. All scripts are located in `apps/api/scripts/`.

## Prerequisites

- `pg_dump`, `pg_restore`, `psql`, `createdb` available in PATH
- `DATABASE_URL` env var set
- Target PostgreSQL accessible from the machine running the scripts

---

## Backup

Creates a compressed pg_dump and records metadata in `backup_metadata`.

```bash
cd apps/api
DATABASE_URL=postgresql://cp:cp@localhost:5433/cp bash scripts/backup.sh
