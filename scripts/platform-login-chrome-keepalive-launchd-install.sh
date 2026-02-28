#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$PWD/scripts/platform-login-chrome-keepalive.mjs" ]]; then
  ROOT="$(cd "$PWD" && pwd -P)"
else
  ROOT="$SCRIPT_ROOT"
fi
LABEL="com.yourorg.codexrelay.chromekeepalive"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
OUT_LOG="$ROOT/state/platform_login_chrome_keepalive.launchd.out.log"
ERR_LOG="$ROOT/state/platform_login_chrome_keepalive.launchd.err.log"
INTERVAL_MIN="${LOGIN_CHROME_KEEPALIVE_INTERVAL_MIN:-25}"
ONLY="${1:-wechat_official,bilibili,weibo,zhihu,douyin,kuaishou,video_channel,jike}"
NODE_BIN="$(command -v node || true)"

if [[ -z "$NODE_BIN" ]]; then
  echo "node_not_found"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$ROOT/state"

if [[ "$ROOT" == "$HOME/Desktop/"* || "$ROOT" == "$HOME/Documents/"* || "$ROOT" == "$HOME/Downloads/"* ]]; then
  echo "warning: workspace is under macOS protected folders ($ROOT); launchd may fail with getcwd permission errors."
fi

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/scripts/platform-login-chrome-keepalive.mjs</string>
    <string>--forever</string>
    <string>--interval-min</string>
    <string>$INTERVAL_MIN</string>
    <string>--only</string>
    <string>$ONLY</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$OUT_LOG</string>
  <key>StandardErrorPath</key>
  <string>$ERR_LOG</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "installed launchd service: $LABEL"
echo "plist: $PLIST"
echo "stdout: $OUT_LOG"
echo "stderr: $ERR_LOG"
