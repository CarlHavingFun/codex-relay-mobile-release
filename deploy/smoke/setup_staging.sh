#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="${1:-}"

usage() {
  cat <<USAGE
Usage:
  ./deploy/smoke/setup_staging.sh [macmini|server]

Purpose:
  Create an isolated staging environment that does NOT overwrite your current prod setup.
USAGE
}

rand_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    date +%s | shasum | awk '{print $1}'
  fi
}

setup_macmini() {
  local env_file="$ROOT/config/.env.staging"
  cp "$ROOT/config/.env.example" "$env_file"

  local base_url="${STAGING_RELAY_BASE_URL:-https://relay-staging.example.com}"
  local token="${STAGING_RELAY_TOKEN:-$(rand_token)}"

  set_kv() {
    local key="$1"
    local val="$2"
    if grep -qE "^${key}=" "$env_file"; then
      sed -i.bak "s#^${key}=.*#${key}=${val}#" "$env_file"
    else
      printf '%s=%s\n' "$key" "$val" >> "$env_file"
    fi
  }

  set_kv RELAY_BASE_URL "$base_url"
  set_kv RELAY_TOKEN "$token"
  set_kv DEFAULT_WORKSPACE "staging"
  set_kv CONNECTOR_WORKSPACE "staging"
  set_kv STATE_DIR "$ROOT/state_staging"
  set_kv SERVICE_LABEL_PREFIX "com.yourorg.codexrelay.staging"
  set_kv PLAN_FILE "$ROOT/PLAN.staging.md"
  set_kv WORKSPACE_PATH "$ROOT"

  rm -f "$env_file.bak"
  chmod 600 "$env_file"

  if [[ ! -f "$ROOT/PLAN.staging.md" ]]; then
    cat > "$ROOT/PLAN.staging.md" <<'PLAN'
# PLAN (staging)
- [ ] [AUTO] staging smoke test task
PLAN
  fi

  echo "created: $env_file"
  echo "starting staging launchd services with isolated labels/state..."

  CONFIG_ENV_FILE="$env_file" npm --prefix "$ROOT" run runner:install-launchd
  CONFIG_ENV_FILE="$env_file" npm --prefix "$ROOT" run connector:install-launchd
  CONFIG_ENV_FILE="$env_file" npm --prefix "$ROOT" run runner:start
  CONFIG_ENV_FILE="$env_file" npm --prefix "$ROOT" run connector:start
  CONFIG_ENV_FILE="$env_file" npm --prefix "$ROOT" run runner:status
  CONFIG_ENV_FILE="$env_file" npm --prefix "$ROOT" run connector:status

  echo
  echo "staging mac mini ready"
  echo "config: $env_file"
  echo "label prefix: com.yourorg.codexrelay.staging"
}

setup_server() {
  local install_dir="${STAGING_INSTALL_DIR:-/opt/codex_relay_mobile_staging}"
  local service_name="${STAGING_SERVICE_NAME:-codex-relay-staging}"
  local env_file="${STAGING_ENV_FILE:-$install_dir/config/.env.staging}"
  local run_user="${STAGING_RUN_USER:-codexrelay}"
  local relay_port="${STAGING_RELAY_PORT:-8794}"
  local relay_base_url="${STAGING_RELAY_BASE_URL:-https://relay-staging.example.com}"

  INSTALL_DIR="$install_dir" \
  RUN_USER="$run_user" \
  ENV_FILE="$env_file" \
  SERVICE_NAME="$service_name" \
  RELAY_PORT_VALUE="$relay_port" \
  RELAY_BASE_URL_VALUE="$relay_base_url" \
  DEFAULT_WORKSPACE_VALUE="staging" \
  CONNECTOR_WORKSPACE_VALUE="staging" \
  STATE_DIR_VALUE="$install_dir/state_staging" \
  bash "$ROOT/deploy/server/install_ubuntu22.sh"

  echo
  echo "staging server ready"
  echo "service: $service_name"
  echo "env: $env_file"
  echo "relay port: $relay_port"
  echo "next: add nginx subpath /codex-relay-staging/ -> 127.0.0.1:$relay_port"
}

case "$MODE" in
  macmini) setup_macmini ;;
  server) setup_server ;;
  *) usage; exit 1 ;;
esac
