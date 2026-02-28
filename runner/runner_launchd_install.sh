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
LABEL="${SERVICE_LABEL_PREFIX}.runner"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
OUT_LOG="$ROOT/state/runner.launchd.out.log"
ERR_LOG="$ROOT/state/runner.launchd.err.log"

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
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>cd $ROOT && CONFIG_ENV_FILE=$ENV_FILE node $ROOT/runner/runner.js</string>
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
