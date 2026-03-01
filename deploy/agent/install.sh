#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${CONFIG_ENV_FILE:-$ROOT/config/.env}"
OS="$(uname -s)"

usage() {
  cat <<USAGE
Usage:
  ./deploy/agent/install.sh

Flow:
  1. Install dependencies
  2. Generate desktop pairing QR
  3. Wait for mobile login + QR confirm and claim connector token
  4. Install/start local services for this OS
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

cd "$ROOT"

npm ci

if [[ -n "${PLATFORM_ACCESS_TOKEN:-}" ]]; then
  node scripts/desktop-pairing.mjs --start --access-token "$PLATFORM_ACCESS_TOKEN" --env-file "$ENV_FILE"
else
  node scripts/desktop-pairing.mjs --start --env-file "$ENV_FILE"
fi
node scripts/desktop-pairing.mjs --wait --env-file "$ENV_FILE"

case "$OS" in
  Darwin)
    CONFIG_ENV_FILE="$ENV_FILE" npm run runner:install-launchd
    CONFIG_ENV_FILE="$ENV_FILE" npm run connector:install-launchd
    CONFIG_ENV_FILE="$ENV_FILE" npm run runner:start
    CONFIG_ENV_FILE="$ENV_FILE" npm run connector:start
    ;;
  Linux)
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/codex-relay-runner.service" <<EOF
[Unit]
Description=Codex Relay Runner
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=CONFIG_ENV_FILE=$ENV_FILE
ExecStart=/usr/bin/env node $ROOT/runner/runner.js
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF

    cat > "$HOME/.config/systemd/user/codex-relay-connector.service" <<EOF
[Unit]
Description=Codex Relay Connector
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=CONFIG_ENV_FILE=$ENV_FILE
ExecStart=/usr/bin/env node $ROOT/runner/chat_connector.js
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF

    systemctl --user daemon-reload
    systemctl --user enable --now codex-relay-runner.service
    systemctl --user enable --now codex-relay-connector.service
    ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

echo "agent install done"
echo "next: ./deploy/agent/doctor.sh"
