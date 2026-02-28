#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.yourorg.codexrelay.codexcp.threaddispatcher"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
OUT_LOG="$ROOT/state/codexcp_thread_dispatcher.launchd.out.log"
ERR_LOG="$ROOT/state/codexcp_thread_dispatcher.launchd.err.log"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
  echo "node binary not found in PATH"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$ROOT/state"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/scripts/codexcp-thread-dispatcher.mjs</string>
    <string>run</string>
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
