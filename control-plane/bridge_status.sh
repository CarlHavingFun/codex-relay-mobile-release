#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION="codex_cp_bridge"
PID_FILE="$ROOT/state/control_plane_bridge.pid"
STATE_FILE="$ROOT/state/control_plane_bridge_state.json"
LOG_FILE="$ROOT/state/control_plane_bridge.log"

echo "=== tmux ==="
if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux ls | grep "$SESSION" || true
else
  echo "tmux session not running"
fi

echo
echo "=== process ==="
PIDS=$(pgrep -f "node $ROOT/control-plane/worker_relay_bridge.js" || true)
if [ -n "${PIDS:-}" ]; then
  ps -o pid,ppid,etime,command -p "$(echo "$PIDS" | tr '\n' ',' | sed 's/,$//')" || true
else
  echo "control-plane bridge process not running"
fi

echo
echo "=== nohup pid ==="
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    echo "control-plane bridge pid: $PID (running)"
  else
    echo "pid file exists but process is not running"
    rm -f "$PID_FILE"
  fi
else
  echo "no pid file"
fi

echo
echo "=== state ==="
cat "$STATE_FILE" 2>/dev/null || echo "missing"

echo
echo "=== logs (tail) ==="
if [ -f "$LOG_FILE" ]; then
  tail -n 30 "$LOG_FILE"
else
  echo "missing: $LOG_FILE"
fi
