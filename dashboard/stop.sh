#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT/state/dashboard.pid"
if [ ! -f "$PID_FILE" ]; then
  echo "dashboard not running"
  exit 0
fi
PID=$(cat "$PID_FILE" 2>/dev/null || true)
if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
  kill "$PID" 2>/dev/null || true
  echo "dashboard stopped pid=$PID"
else
  echo "dashboard pid file exists but process not running"
fi
rm -f "$PID_FILE"
