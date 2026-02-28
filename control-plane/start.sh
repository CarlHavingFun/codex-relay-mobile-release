#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION="codex_control_plane"
LOG="$ROOT/state/control_plane.log"
PID_FILE="$ROOT/state/control_plane.pid"

mkdir -p "$ROOT/state"

if command -v tmux >/dev/null 2>&1; then
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "control-plane already running in tmux session: $SESSION"
    exit 0
  fi
  tmux new-session -d -s "$SESSION" "node $ROOT/control-plane/server.js >> $LOG 2>&1"
  echo "started control-plane tmux session: $SESSION"
  echo "logs: $LOG"
  exit 0
fi

if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "control-plane already running with pid: $OLD_PID"
    exit 0
  fi
fi

nohup node "$ROOT/control-plane/server.js" >> "$LOG" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
echo "started control-plane with nohup pid: $NEW_PID"
echo "logs: $LOG"
