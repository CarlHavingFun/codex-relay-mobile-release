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
PID_FILE="$ROOT/state/runner.pid"
STATE_FILE="$ROOT/state/runner_state.json"
STALE_SEC="${RUNNER_STATE_STALE_SECONDS:-90}"
LABEL="${SERVICE_LABEL_PREFIX}.runner"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "=== launchd ==="
if ! command -v launchctl >/dev/null 2>&1; then
  echo "launchctl not available on this OS"
elif launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "launchd service running: $LABEL"
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
PIDS=$(pgrep -f "node $ROOT/runner/runner.js" || true)
if [ -n "${PIDS:-}" ]; then
  ps -o pid,ppid,etime,command -p "$(echo "$PIDS" | tr '\n' ',' | sed 's/,$//')" || true
else
  echo "runner process not running"
fi

echo
echo "=== nohup pid ==="
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    echo "runner pid: $PID (running)"
  else
    echo "pid file exists but process is not running"
    rm -f "$PID_FILE"
    echo "removed stale pid file: $PID_FILE"
  fi
else
  echo "no pid file"
fi

echo
echo "=== runner_state.json ==="
cat "$STATE_FILE" 2>/dev/null || echo "missing"

if [ -f "$STATE_FILE" ]; then
  echo
  echo "=== state freshness ==="
  node - "$STATE_FILE" "$STALE_SEC" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const staleSec = Number(process.argv[3] || 90);
try {
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const updatedAt = Date.parse(state.updated_at || '');
  if (!Number.isFinite(updatedAt)) {
    console.log('runner_state has no valid updated_at');
    process.exit(0);
  }
  const ageSec = Math.floor((Date.now() - updatedAt) / 1000);
  const stale = ageSec > staleSec;
  console.log(`updated_at_age_sec=${ageSec} stale_threshold_sec=${staleSec} stale=${stale}`);
  if (stale) {
    console.log('WARNING: runner_state appears stale. Process may be offline even if state.online=true');
  }
} catch (err) {
  console.log(`failed to parse runner_state: ${err.message}`);
}
NODE
fi

echo
echo "=== pending approvals ==="
node -e 'const fs=require("fs");const f=process.argv[1];const a=JSON.parse(fs.readFileSync(f,"utf8"));console.log(a.filter(x=>x.state==="pending").length);' "$ROOT/state/approvals.json" 2>/dev/null || echo "n/a"
