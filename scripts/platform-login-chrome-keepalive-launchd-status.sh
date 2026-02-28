#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$PWD/scripts/platform-login-chrome-keepalive.mjs" ]]; then
  ROOT="$(cd "$PWD" && pwd -P)"
else
  ROOT="$SCRIPT_ROOT"
fi
LABEL="com.yourorg.codexrelay.chromekeepalive"
OUT_LOG="$ROOT/state/platform_login_chrome_keepalive.launchd.out.log"
ERR_LOG="$ROOT/state/platform_login_chrome_keepalive.launchd.err.log"
STATE_FILE="$ROOT/state/platform_login_chrome_keepalive.json"

launchctl print "gui/$(id -u)/$LABEL" >/tmp/codexiphone_chrome_keepalive_launchd_status.txt 2>&1 || true
cat /tmp/codexiphone_chrome_keepalive_launchd_status.txt

if [[ -f "$STATE_FILE" ]]; then
  echo "--- state ---"
  tail -n 40 "$STATE_FILE"
fi

if [[ -f "$OUT_LOG" ]]; then
  echo "--- stdout ---"
  tail -n 30 "$OUT_LOG"
fi

if [[ -f "$ERR_LOG" ]]; then
  echo "--- stderr ---"
  tail -n 30 "$ERR_LOG"
fi
