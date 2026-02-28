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

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl disable "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"

echo "uninstalled launchd service: $LABEL"
