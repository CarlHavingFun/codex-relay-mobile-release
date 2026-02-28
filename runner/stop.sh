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
SESSION="codex_runner"
PID_FILE="$ROOT/state/runner.pid"
LABEL="${SERVICE_LABEL_PREFIX}.runner"

STOPPED=0

if command -v launchctl >/dev/null 2>&1 && launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  echo "stopped launchd service: $LABEL"
  STOPPED=1
fi

if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux kill-session -t "$SESSION"
  echo "stopped tmux session: $SESSION"
  STOPPED=1
fi

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    echo "stopped nohup runner pid: $PID"
    STOPPED=1
  fi
  rm -f "$PID_FILE"
fi

if [ "$STOPPED" -eq 0 ]; then
  echo "runner not running"
fi
