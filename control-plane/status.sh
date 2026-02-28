#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION="codex_control_plane"
PID_FILE="$ROOT/state/control_plane.pid"
STATE_LOG="$ROOT/state/control_plane.log"

PORT="${CONTROL_PLANE_PORT:-8790}"

echo "=== tmux ==="
if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux ls | grep "$SESSION" || true
else
  echo "tmux session not running"
fi

echo
echo "=== process ==="
PIDS=$(pgrep -f "node $ROOT/control-plane/server.js" || true)
if [ -n "${PIDS:-}" ]; then
  ps -o pid,ppid,etime,command -p "$(echo "$PIDS" | tr '\n' ',' | sed 's/,$//')" || true
else
  echo "control-plane process not running"
fi

echo
echo "=== nohup pid ==="
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    echo "control-plane pid: $PID (running)"
  else
    echo "pid file exists but process is not running"
    rm -f "$PID_FILE"
  fi
else
  echo "no pid file"
fi

echo
echo "=== health ==="
if command -v curl >/dev/null 2>&1; then
  curl -sf "http://127.0.0.1:${PORT}/healthz" || echo "healthz unavailable"
else
  echo "curl not available"
fi

echo
echo "=== logs (tail) ==="
if [ -f "$STATE_LOG" ]; then
  tail -n 30 "$STATE_LOG"
else
  echo "missing: $STATE_LOG"
fi
