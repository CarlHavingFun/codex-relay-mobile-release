#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/state/platform_login_keepalive.pid"
LOG_FILE="$ROOT/state/platform_login_keepalive.log"

mkdir -p "$ROOT/state"

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${PID}" ]] && kill -0 "$PID" >/dev/null 2>&1; then
    echo "already_running pid=$PID"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

ONLY="${1:-wechat_official,bilibili,weibo,zhihu,douyin,kuaishou,video_channel,jike}"
INTERVAL_MIN="${LOGIN_KEEPALIVE_INTERVAL_MIN:-25}"
TIMEOUT_SEC="${LOGIN_KEEPALIVE_TIMEOUT_SEC:-45}"

nohup node "$ROOT/scripts/platform-login-keepalive.mjs" \
  --forever \
  --headless \
  --interval-min "$INTERVAL_MIN" \
  --timeout-sec "$TIMEOUT_SEC" \
  --only "$ONLY" >>"$LOG_FILE" 2>&1 &

PID="$!"
echo "$PID" >"$PID_FILE"
echo "started pid=$PID only=$ONLY interval_min=$INTERVAL_MIN"
