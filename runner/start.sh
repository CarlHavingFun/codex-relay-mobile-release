#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/config/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
SERVICE_LABEL_PREFIX="${SERVICE_LABEL_PREFIX:-com.yourorg.codexrelay}"
SESSION="codex_runner"
LABEL="${SERVICE_LABEL_PREFIX}.runner"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$ROOT/state/runner.log"
PID_FILE="$ROOT/state/runner.pid"

mkdir -p "$ROOT/state"

launchd_service_running() {
  launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -q "state = running"
}

runner_process_running() {
  pgrep -f "node $ROOT/runner/runner.js" >/dev/null 2>&1
}

wait_for_runner_process() {
  local retries="${1:-8}"
  local delay="${2:-1}"
  local i
  for ((i=0; i<retries; i+=1)); do
    if runner_process_running; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

if command -v launchctl >/dev/null 2>&1 && launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  if launchd_service_running && wait_for_runner_process 8 1; then
    echo "started runner launchd service: $LABEL"
    echo "logs: $ROOT/state/runner.launchd.out.log"
    exit 0
  fi
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  echo "launchd service failed to stay running; falling back to tmux/nohup"
fi

if command -v launchctl >/dev/null 2>&1 && [ -f "$PLIST" ]; then
  launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  launchctl enable "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  if launchd_service_running && wait_for_runner_process 8 1; then
    echo "started runner launchd service: $LABEL"
    echo "logs: $ROOT/state/runner.launchd.out.log"
    exit 0
  fi
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  echo "launchd bootstrap/kickstart did not produce a running service; falling back to tmux/nohup"
fi

if command -v tmux >/dev/null 2>&1; then
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "runner already running in tmux session: $SESSION"
    exit 0
  fi
  tmux new-session -d -s "$SESSION" "node $ROOT/runner/runner.js >> $LOG 2>&1"
  echo "started tmux session: $SESSION"
  echo "logs: $LOG"
  exit 0
fi

# Fallback: no tmux available, use nohup + pid file.
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "runner already running with pid: $OLD_PID"
    exit 0
  fi
fi

nohup node "$ROOT/runner/runner.js" >> "$LOG" 2>&1 &
NEW_PID=$!
sleep 1
if kill -0 "$NEW_PID" 2>/dev/null; then
  echo "$NEW_PID" > "$PID_FILE"
  echo "started runner with nohup pid: $NEW_PID"
  echo "logs: $LOG"
  exit 0
fi
echo "failed to start runner with nohup; check logs: $LOG" >&2
exit 1
