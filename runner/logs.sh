#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$ROOT/state/runner.log"
LINES="${1:-120}"
if [[ ! -f "$LOG" ]]; then
  echo "log file not found: $LOG"
  exit 1
fi
tail -n "$LINES" -f "$LOG"
