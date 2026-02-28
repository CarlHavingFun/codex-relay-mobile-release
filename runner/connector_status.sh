#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${CONFIG_ENV_FILE:-$ROOT/config/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
SERVICE_LABEL_PREFIX="${SERVICE_LABEL_PREFIX:-com.yourorg.codexrelay}"
SESSION="codex_chat_connector"
PID_FILE="$ROOT/state/chat_connector.pid"
LABEL="${SERVICE_LABEL_PREFIX}.chatconnector"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "=== launchd ==="
LAUNCHD_RUNNING=0
if ! command -v launchctl >/dev/null 2>&1; then
  echo "launchctl not available on this OS"
elif launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "launchd service running: $LABEL"
  LAUNCHD_RUNNING=1
  launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | sed -n '/^[[:space:]]*pid = /p' || true
else
  echo "launchd service not running: $LABEL"
fi
if [ -f "$PLIST" ]; then
  echo "launchd plist present: $PLIST"
else
  echo "launchd plist not installed"
fi

echo "=== tmux ==="
if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux ls | grep "$SESSION" || true
else
  echo "tmux session not running"
fi

echo
echo "=== process ==="
PIDS=$(pgrep -f "node $ROOT/runner/chat_connector.js" || true)
if [ -n "${PIDS:-}" ]; then
  ps -o pid,ppid,etime,command -p "$(echo "$PIDS" | tr '\n' ',' | sed 's/,$//')" || true
else
  echo "connector process not running"
  if [ "$LAUNCHD_RUNNING" -eq 1 ]; then
    echo "warning: launchd reports running but connector process is missing (likely rapid crash/restart loop)"
  fi
fi

echo
echo "=== nohup pid ==="
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    echo "connector pid: $PID (running)"
  else
    echo "pid file exists but process is not running"
  fi
else
  echo "no pid file"
fi

echo
echo "=== connector state ==="
cat "$ROOT/state/chat_connector_state.json" 2>/dev/null || echo "missing"
