#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm tsx src/reconciliation/manualRun.ts
