#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/codex_relay_mobile}"
RUN_USER="${RUN_USER:-codexrelay}"
ENV_FILE="${ENV_FILE:-$INSTALL_DIR/config/.env}"
SERVICE_NAME="${SERVICE_NAME:-codex-relay}"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
WATCHDOG_SERVICE_NAME="${WATCHDOG_SERVICE_NAME:-${SERVICE_NAME}-watchdog}"
WATCHDOG_UNIT_BASENAME="${WATCHDOG_SERVICE_NAME%.service}"
WATCHDOG_SERVICE_UNIT="${WATCHDOG_UNIT_BASENAME}.service"
WATCHDOG_TIMER_UNIT="${WATCHDOG_UNIT_BASENAME}.timer"
WATCHDOG_SERVICE_PATH="/etc/systemd/system/${WATCHDOG_SERVICE_UNIT}"
WATCHDOG_TIMER_PATH="/etc/systemd/system/${WATCHDOG_TIMER_UNIT}"
RELAY_BASE_URL_VALUE="${RELAY_BASE_URL_VALUE:-https://relay.example.com}"
DEFAULT_WORKSPACE_VALUE="${DEFAULT_WORKSPACE_VALUE:-default}"
CONNECTOR_WORKSPACE_VALUE="${CONNECTOR_WORKSPACE_VALUE:-default}"
STATE_DIR_VALUE="${STATE_DIR_VALUE:-$INSTALL_DIR/state}"
RELAY_PORT_VALUE="${RELAY_PORT_VALUE:-}"

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

$SUDO sed -i "s#^RELAY_BASE_URL=.*#RELAY_BASE_URL=${RELAY_BASE_URL_VALUE}#" "$ENV_FILE"
$SUDO sed -i "s#^DEFAULT_WORKSPACE=.*#DEFAULT_WORKSPACE=${DEFAULT_WORKSPACE_VALUE}#" "$ENV_FILE"
$SUDO sed -i "s#^CONNECTOR_WORKSPACE=.*#CONNECTOR_WORKSPACE=${CONNECTOR_WORKSPACE_VALUE}#" "$ENV_FILE"
$SUDO sed -i "s#^STATE_DIR=.*#STATE_DIR=${STATE_DIR_VALUE}#" "$ENV_FILE"

if [[ -n "$RELAY_PORT_VALUE" ]]; then
  if $SUDO grep -q '^RELAY_PORT=' "$ENV_FILE"; then
    $SUDO sed -i "s#^RELAY_PORT=.*#RELAY_PORT=${RELAY_PORT_VALUE}#" "$ENV_FILE"
  else
    echo "RELAY_PORT=${RELAY_PORT_VALUE}" | $SUDO tee -a "$ENV_FILE" >/dev/null
  fi
fi

TMP_SERVICE="$(mktemp)"
sed -e "s#{{RUN_USER}}#${RUN_USER}#g" \
    -e "s#{{INSTALL_DIR}}#${INSTALL_DIR}#g" \
    -e "s#{{ENV_FILE}}#${ENV_FILE}#g" \
    "$INSTALL_DIR/relay/deploy/codex-relay.service" > "$TMP_SERVICE"
$SUDO mv "$TMP_SERVICE" "$SERVICE_PATH"

TMP_WATCHDOG_SERVICE="$(mktemp)"
sed -e "s#{{SERVICE_NAME}}#${SERVICE_NAME}#g" \
    -e "s#{{INSTALL_DIR}}#${INSTALL_DIR}#g" \
    -e "s#{{ENV_FILE}}#${ENV_FILE}#g" \
    "$INSTALL_DIR/deploy/server/codex-relay-watchdog.service" > "$TMP_WATCHDOG_SERVICE"
$SUDO mv "$TMP_WATCHDOG_SERVICE" "$WATCHDOG_SERVICE_PATH"

TMP_WATCHDOG_TIMER="$(mktemp)"
sed -e "s#{{WATCHDOG_SERVICE_UNIT}}#${WATCHDOG_SERVICE_UNIT}#g" \
    "$INSTALL_DIR/deploy/server/codex-relay-watchdog.timer" > "$TMP_WATCHDOG_TIMER"
$SUDO mv "$TMP_WATCHDOG_TIMER" "$WATCHDOG_TIMER_PATH"

$SUDO chown -R "$RUN_USER":"$RUN_USER" "$INSTALL_DIR"
$SUDO chmod 600 "$ENV_FILE"
$SUDO chmod +x "$INSTALL_DIR/deploy/server/watchdog_relay.sh"

$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SERVICE_NAME"
$SUDO systemctl restart "$SERVICE_NAME"
$SUDO systemctl enable "$WATCHDOG_TIMER_UNIT"
$SUDO systemctl restart "$WATCHDOG_TIMER_UNIT"
$SUDO systemctl start "$WATCHDOG_SERVICE_UNIT" || true
$SUDO systemctl --no-pager --full status "$SERVICE_NAME" || true
$SUDO systemctl --no-pager --full status "$WATCHDOG_TIMER_UNIT" || true

echo
echo "Install finished."
echo "Next: ./deploy/server/configure_nginx_tls.sh (with RELAY_DOMAIN and CERTBOT_EMAIL)"
