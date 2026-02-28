#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/state/platform_login_chrome_keepalive.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "not_running"
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [[ -z "${PID}" ]]; then
  rm -f "$PID_FILE"
  echo "not_running"
  exit 0
fi

if kill -0 "$PID" >/dev/null 2>&1; then
  kill "$PID" >/dev/null 2>&1 || true
  sleep 1
  if kill -0 "$PID" >/dev/null 2>&1; then
    kill -9 "$PID" >/dev/null 2>&1 || true
  fi
  echo "stopped pid=$PID"
else
  echo "not_running"
fi

rm -f "$PID_FILE"
