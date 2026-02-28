#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="${1:-}"

usage() {
  cat <<USAGE
Usage:
  ./deploy/smoke/teardown_staging.sh [macmini|server]

Optional env:
  CLEAN_STATE=1       (macmini) remove staging env/state files
  CLEAN_INSTALL_DIR=1 (server)  remove staging install directory
USAGE
}

set_sudo() {
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    SUDO=""
  fi
}

env_value() {
  local key="$1"
  local file="$2"
  awk -F= -v k="$key" '$1==k{print substr($0, index($0,"=")+1); exit}' "$file"
}

teardown_macmini() {
  local env_file="${STAGING_ENV_FILE:-$ROOT/config/.env.staging}"

  if [[ ! -f "$env_file" ]]; then
    echo "staging env file not found: $env_file"
    echo "nothing to teardown for macmini"
    return 0
  fi

  local state_dir
  state_dir="$(env_value STATE_DIR "$env_file")"

  CONFIG_ENV_FILE="$env_file" npm --prefix "$ROOT" run connector:stop || true
  CONFIG_ENV_FILE="$env_file" npm --prefix "$ROOT" run runner:stop || true
  CONFIG_ENV_FILE="$env_file" npm --prefix "$ROOT" run connector:uninstall-launchd || true
  CONFIG_ENV_FILE="$env_file" npm --prefix "$ROOT" run runner:uninstall-launchd || true

  if [[ "${CLEAN_STATE:-0}" == "1" ]]; then
    rm -f "$env_file"
    rm -f "$ROOT/PLAN.staging.md"
    if [[ -n "$state_dir" && -d "$state_dir" ]]; then
      rm -rf "$state_dir"
    fi
    echo "removed staging files and state"
  fi

  echo "staging macmini teardown done"
}

teardown_server() {
  set_sudo

  local install_dir="${STAGING_INSTALL_DIR:-/opt/codex_relay_mobile_staging}"
  local service_name="${STAGING_SERVICE_NAME:-codex-relay-staging}"
  local service_file="/etc/systemd/system/${service_name}.service"
  local nginx_file="/etc/nginx/conf.d/${service_name}.conf"

  $SUDO systemctl stop "$service_name" || true
  $SUDO systemctl disable "$service_name" || true

  if [[ -f "$service_file" ]]; then
    $SUDO rm -f "$service_file"
  fi
  $SUDO systemctl daemon-reload

  if [[ -f "$nginx_file" ]]; then
    $SUDO rm -f "$nginx_file"
    $SUDO nginx -t && $SUDO systemctl reload nginx
  fi

  if [[ "${CLEAN_INSTALL_DIR:-0}" == "1" && -d "$install_dir" ]]; then
    $SUDO rm -rf "$install_dir"
  fi

  echo "staging server teardown done"
}

case "$MODE" in
  macmini) teardown_macmini ;;
  server) teardown_server ;;
  *) usage; exit 1 ;;
esac
