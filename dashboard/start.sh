#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT/state/dashboard.pid"
LOG_FILE="$ROOT/state/dashboard.log"
PORT="${DASHBOARD_PORT:-8788}"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    echo "dashboard already running pid=$PID port=$PORT"
    exit 0
  fi
fi

nohup env DASHBOARD_PORT="$PORT" node "$ROOT/dashboard/server.js" >> "$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" > "$PID_FILE"
echo "dashboard started pid=$PID port=$PORT"
