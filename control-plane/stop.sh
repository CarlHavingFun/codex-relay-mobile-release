#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION="codex_control_plane"
PID_FILE="$ROOT/state/control_plane.pid"

if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux kill-session -t "$SESSION"
  echo "stopped tmux session: $SESSION"
fi

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    echo "stopped control-plane pid: $PID"
  fi
  rm -f "$PID_FILE"
fi

PIDS=$(pgrep -f "node $ROOT/control-plane/server.js" || true)
if [ -n "${PIDS:-}" ]; then
  while IFS= read -r pid; do
    [ -z "$pid" ] && continue
    kill "$pid" 2>/dev/null || true
  done <<< "$PIDS"
  echo "stopped remaining control-plane processes"
else
  echo "control-plane not running"
fi
