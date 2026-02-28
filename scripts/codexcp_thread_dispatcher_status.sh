#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.yourorg.codexrelay.codexcp.threaddispatcher"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE_FILE="$ROOT/state/codexcp_thread_dispatcher_state.json"

echo "=== launchd ==="
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
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

echo
echo "=== process ==="
PIDS_OUTPUT="$(pgrep -f "node $ROOT/scripts/codexcp-thread-dispatcher.mjs run" 2>&1 || true)"
if [[ "$PIDS_OUTPUT" == *"Cannot get process list"* ]]; then
  echo "dispatcher process check unavailable (pgrep permission denied in current environment)"
elif [ -n "${PIDS_OUTPUT:-}" ]; then
  ps -o pid,ppid,etime,command -p "$(echo "$PIDS_OUTPUT" | tr '\n' ',' | sed 's/,$//')" || true
else
  echo "dispatcher process not running"
fi

echo
echo "=== state ==="
if [ -f "$STATE_FILE" ]; then
  jq -r '{updated_at, target_workspace, mapped_threads: (.thread_map | length)}' "$STATE_FILE"
  echo
  echo "mapped threads by source_workspace:"
  jq -r '
    .thread_map
    | to_entries
    | map(.value.source_workspace // "misc")
    | map((. // "") | gsub("^\\s+|\\s+$"; "") | if . == "" then "misc" else . end)
    | group_by(.)
    | map({workspace: .[0], count: length})
    | sort_by(-.count, .workspace)
    | .[]
    | "\(.workspace)\t\(.count)"
  ' "$STATE_FILE"
else
  echo "missing state file: $STATE_FILE"
fi
