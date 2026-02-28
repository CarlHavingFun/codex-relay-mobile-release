#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/codex_relay_mobile}"
RUN_USER="${RUN_USER:-codexrelay}"
ENV_FILE="${ENV_FILE:-$INSTALL_DIR/config/.env}"
SERVICE_NAME="codex-relay"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer targets Linux (Ubuntu 22.04)." >&2
  exit 1
fi

SUDO=""
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "Run as root or install sudo." >&2
    exit 1
  fi
fi

if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  if [[ "${ID:-}" != "ubuntu" || "${VERSION_ID:-}" != "22.04" ]]; then
    echo "warning: validated for Ubuntu 22.04; detected ${PRETTY_NAME:-unknown}."
  fi
fi

$SUDO apt-get update -y
$SUDO apt-get install -y ca-certificates curl gnupg lsb-release rsync

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/^v//' | cut -d. -f1)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi

if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  $SUDO useradd --system --create-home --shell /bin/bash "$RUN_USER"
fi

$SUDO mkdir -p "$INSTALL_DIR"
$SUDO rsync -a --delete \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='state/' \
  --exclude='output/' \
  --exclude='DerivedData/' \
  --exclude='config/.env' \
  --exclude='config/.relay_token' \
  --exclude='*.xcarchive' \
  --exclude='*.ipa' \
  --exclude='*.dSYM' \
  "$ROOT/" "$INSTALL_DIR/"

if [[ ! -f "$ENV_FILE" ]]; then
  $SUDO mkdir -p "$(dirname "$ENV_FILE")"
  $SUDO cp "$INSTALL_DIR/config/.env.example" "$ENV_FILE"
fi

if $SUDO grep -q '^RELAY_TOKEN=replace-with-strong-token' "$ENV_FILE"; then
  TOKEN="$(openssl rand -hex 32)"
  $SUDO sed -i "s#^RELAY_TOKEN=.*#RELAY_TOKEN=${TOKEN}#" "$ENV_FILE"
fi

$SUDO sed -i "s#^RELAY_BASE_URL=.*#RELAY_BASE_URL=https://relay.example.com#" "$ENV_FILE"
$SUDO sed -i "s#^DEFAULT_WORKSPACE=.*#DEFAULT_WORKSPACE=default#" "$ENV_FILE"
$SUDO sed -i "s#^CONNECTOR_WORKSPACE=.*#CONNECTOR_WORKSPACE=default#" "$ENV_FILE"
$SUDO sed -i "s#^STATE_DIR=.*#STATE_DIR=${INSTALL_DIR}/state#" "$ENV_FILE"

TMP_SERVICE="$(mktemp)"
sed -e "s#{{RUN_USER}}#${RUN_USER}#g" \
    -e "s#{{INSTALL_DIR}}#${INSTALL_DIR}#g" \
    -e "s#{{ENV_FILE}}#${ENV_FILE}#g" \
    "$INSTALL_DIR/relay/deploy/codex-relay.service" > "$TMP_SERVICE"
$SUDO mv "$TMP_SERVICE" "$SERVICE_PATH"

$SUDO chown -R "$RUN_USER":"$RUN_USER" "$INSTALL_DIR"
$SUDO chmod 600 "$ENV_FILE"

$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SERVICE_NAME"
$SUDO systemctl restart "$SERVICE_NAME"
$SUDO systemctl --no-pager --full status "$SERVICE_NAME" || true

echo
echo "Install finished."
echo "Next: ./deploy/server/configure_nginx_tls.sh (with RELAY_DOMAIN and CERTBOT_EMAIL)"
