#!/usr/bin/env bash
set -euo pipefail

LABEL="com.yourorg.codexrelay.chromekeepalive"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl disable "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"

echo "uninstalled launchd service: $LABEL"
