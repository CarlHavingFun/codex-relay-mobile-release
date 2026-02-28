#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/state/platform_login_chrome_keepalive.pid"
LOG_FILE="$ROOT/state/platform_login_chrome_keepalive.log"
STATE_FILE="$ROOT/state/platform_login_chrome_keepalive.json"

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${PID}" ]] && kill -0 "$PID" >/dev/null 2>&1; then
    echo "running pid=$PID"
  else
    echo "stale_pid_file"
  fi
else
  echo "not_running"
fi

if [[ -f "$STATE_FILE" ]]; then
  echo "--- state ---"
  tail -n 40 "$STATE_FILE"
fi

if [[ -f "$LOG_FILE" ]]; then
  echo "--- log ---"
  tail -n 30 "$LOG_FILE"
fi
