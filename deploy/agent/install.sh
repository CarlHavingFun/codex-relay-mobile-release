#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${CONFIG_ENV_FILE:-$ROOT/config/.env}"
OS="$(uname -s)"
PLATFORM_DEFAULT_LOCAL="http://127.0.0.1:8791"
PLATFORM_STATE_DIR="$ROOT/state/platform-api"
PLATFORM_PID_FILE="$PLATFORM_STATE_DIR/platform-api.pid"
PLATFORM_LOG_FILE="$PLATFORM_STATE_DIR/platform-api.log"
LOCAL_PG_CONTAINER="${LOCAL_PG_CONTAINER:-codex-platform-pg}"
LOCAL_PG_PORT="${LOCAL_PG_PORT:-55432}"

log() {
  echo "[agent-install] $*"
}

fail() {
  echo "[agent-install] ERROR: $*" >&2
  exit 1
}

usage() {
  cat <<USAGE
Usage:
  ./deploy/agent/install.sh

Quick Guide Flow:
  1. Ensure required dependencies (node/npm/codex)
  2. Ensure Codex login state
  3. Ensure env secrets (RELAY_TOKEN/PLATFORM_JWT_SECRET)
  4. Start local platform-api when PLATFORM_BASE_URL is local
  5. Generate desktop pairing QR and wait mobile scan/confirm
  6. Install/start runner+connector services
  7. Auto-run doctor checks

Optional env:
  CONFIG_ENV_FILE=/path/to/.env
  PLATFORM_BASE_URL=https://platform.example.com   # use remote platform API
  PLATFORM_ACCESS_TOKEN=...                        # optional, can be empty
  LOCAL_PG_CONTAINER=codex-platform-pg
  LOCAL_PG_PORT=55432
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

ensure_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    return
  fi
  mkdir -p "$(dirname "$ENV_FILE")"
  if [[ -f "$ROOT/config/.env.example" ]]; then
    cp "$ROOT/config/.env.example" "$ENV_FILE"
    log "created env file from template: $ENV_FILE"
    return
  fi
  touch "$ENV_FILE"
  log "created empty env file: $ENV_FILE"
}

env_get() {
  local key="$1"
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 || true)"
  if [[ -z "$line" ]]; then
    return
  fi
  echo "${line#*=}"
}

env_set() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i.bak "s|^${key}=.*$|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

safe_random_hex() {
  local bytes="$1"
  if has_cmd openssl; then
    openssl rand -hex "$bytes"
    return
  fi
  node -e "process.stdout.write(require('node:crypto').randomBytes(${bytes}).toString('hex'))"
}

ensure_secret_key() {
  local key="$1"
  local bytes="$2"
  local current
  current="$(env_get "$key")"
  if [[ -n "${current:-}" ]]; then
    return
  fi
  local generated
  generated="$(safe_random_hex "$bytes")"
  env_set "$key" "$generated"
  log "generated secret: $key"
}

install_node_mac() {
  if ! has_cmd brew; then
    return 1
  fi
  brew install node
}

install_node_linux() {
  if has_cmd apt-get; then
    sudo apt-get update
    sudo apt-get install -y nodejs npm
    return 0
  fi
  return 1
}

ensure_node_npm() {
  if has_cmd node && has_cmd npm; then
    return
  fi

  log "node/npm missing, trying auto install"
  case "$OS" in
    Darwin)
      install_node_mac || fail "failed to auto install node on macOS (install Homebrew+Node manually)"
      ;;
    Linux)
      install_node_linux || fail "failed to auto install node on Linux (install nodejs/npm manually)"
      ;;
    *)
      fail "unsupported OS for auto node install: $OS"
      ;;
  esac

  has_cmd node || fail "node is still missing after install"
  has_cmd npm || fail "npm is still missing after install"
}

ensure_codex_cli() {
  local codex_bin="${CODEX_BIN:-$(env_get CODEX_BIN)}"
  if [[ -z "$codex_bin" ]]; then
    codex_bin="codex"
  fi

  if has_cmd "$codex_bin"; then
    return
  fi

  log "codex CLI missing, trying npm global install (@openai/codex)"
  npm install -g @openai/codex || fail "codex install failed; run: npm install -g @openai/codex"

  if ! has_cmd "$codex_bin"; then
    fail "codex binary '$codex_bin' not found after install"
  fi
}

ensure_codex_login() {
  local codex_bin="${CODEX_BIN:-$(env_get CODEX_BIN)}"
  if [[ -z "$codex_bin" ]]; then
    codex_bin="codex"
  fi

  local status_text
  status_text="$("$codex_bin" login status 2>&1 || true)"
  if echo "$status_text" | grep -qi "logged in"; then
    log "codex login status: logged in"
    return
  fi

  log "codex login required"
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    log "detected OPENAI_API_KEY, attempting codex login with API key"
    if ! printf '%s' "$OPENAI_API_KEY" | "$codex_bin" login --with-api-key >/dev/null 2>&1; then
      fail "codex API key login failed"
    fi
  else
    log "starting codex device-auth login (follow terminal prompt)"
    "$codex_bin" login --device-auth || fail "codex device-auth login failed"
  fi

  status_text="$("$codex_bin" login status 2>&1 || true)"
  if ! echo "$status_text" | grep -qi "logged in"; then
    fail "codex login status is not ready: $status_text"
  fi
}

is_local_platform_url() {
  local url="$1"
  case "$url" in
    http://127.0.0.1:*|http://localhost:*|https://127.0.0.1:*|https://localhost:*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

wait_for_http() {
  local url="$1"
  local timeout_seconds="$2"
  local started
  started="$(date +%s)"
  while true; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    if (( $(date +%s) - started >= timeout_seconds )); then
      return 1
    fi
    sleep 1
  done
}

ensure_local_platform_db() {
  local db_url
  db_url="${PLATFORM_DATABASE_URL:-$(env_get PLATFORM_DATABASE_URL)}"
  if [[ -n "$db_url" ]]; then
    return
  fi

  if ! has_cmd docker; then
    fail "PLATFORM_DATABASE_URL is missing and docker is unavailable"
  fi

  log "PLATFORM_DATABASE_URL missing, bootstrapping local PostgreSQL via docker"

  if ! docker ps --format '{{.Names}}' | grep -qx "$LOCAL_PG_CONTAINER"; then
    if docker ps -a --format '{{.Names}}' | grep -qx "$LOCAL_PG_CONTAINER"; then
      docker start "$LOCAL_PG_CONTAINER" >/dev/null
    else
      docker run -d \
        --name "$LOCAL_PG_CONTAINER" \
        -e POSTGRES_DB=codex_platform \
        -e POSTGRES_USER=codex \
        -e POSTGRES_PASSWORD=codex \
        -p "$LOCAL_PG_PORT":5432 \
        postgres:16-alpine >/dev/null
    fi
  fi

  db_url="postgres://codex:codex@127.0.0.1:${LOCAL_PG_PORT}/codex_platform"
  env_set PLATFORM_DATABASE_URL "$db_url"
  log "set PLATFORM_DATABASE_URL=$db_url"
}

ensure_platform_relay_base_url() {
  local relay_base
  relay_base="${PLATFORM_RELAY_BASE_URL:-$(env_get PLATFORM_RELAY_BASE_URL)}"
  if [[ -n "$relay_base" ]]; then
    return
  fi
  relay_base="${RELAY_BASE_URL:-$(env_get RELAY_BASE_URL)}"
  if [[ -z "$relay_base" ]]; then
    fail "RELAY_BASE_URL missing in env; cannot infer PLATFORM_RELAY_BASE_URL"
  fi
  env_set PLATFORM_RELAY_BASE_URL "$relay_base"
  log "set PLATFORM_RELAY_BASE_URL=$relay_base"
}

start_local_platform_api_if_needed() {
  local pairing_base_url
  pairing_base_url="${PLATFORM_BASE_URL:-${PLATFORM_API_BASE_URL:-$(env_get PLATFORM_BASE_URL)}}"
  if [[ -z "$pairing_base_url" ]]; then
    pairing_base_url="$PLATFORM_DEFAULT_LOCAL"
  fi

  if ! is_local_platform_url "$pairing_base_url"; then
    log "using remote platform API: $pairing_base_url"
    if ! wait_for_http "${pairing_base_url%/}/healthz" 12; then
      fail "remote platform API unreachable: ${pairing_base_url%/}/healthz"
    fi
    export PLATFORM_BASE_URL="$pairing_base_url"
    return
  fi

  ensure_secret_key PLATFORM_JWT_SECRET 32
  ensure_platform_relay_base_url
  ensure_local_platform_db

  export CONFIG_ENV_FILE="$ENV_FILE"
  npm --prefix "$ROOT" run platform-api:migrate

  mkdir -p "$PLATFORM_STATE_DIR"

  if wait_for_http "${pairing_base_url%/}/healthz" 2; then
    log "local platform API already running at $pairing_base_url"
    export PLATFORM_BASE_URL="$pairing_base_url"
    return
  fi

  if [[ -f "$PLATFORM_PID_FILE" ]]; then
    local old_pid
    old_pid="$(cat "$PLATFORM_PID_FILE" || true)"
    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" >/dev/null 2>&1; then
      kill "$old_pid" >/dev/null 2>&1 || true
      sleep 1
    fi
  fi

  log "starting local platform API: $pairing_base_url"
  (
    cd "$ROOT"
    CONFIG_ENV_FILE="$ENV_FILE" nohup node platform-api/server.js >>"$PLATFORM_LOG_FILE" 2>&1 &
    echo $! > "$PLATFORM_PID_FILE"
  )

  if ! wait_for_http "${pairing_base_url%/}/healthz" 25; then
    fail "platform-api failed to start; check log: $PLATFORM_LOG_FILE"
  fi

  export PLATFORM_BASE_URL="$pairing_base_url"
}

run_pairing_flow() {
  local env_file="$1"
  local pairing_url="${PLATFORM_BASE_URL:-$PLATFORM_DEFAULT_LOCAL}"

  if [[ -n "${PLATFORM_ACCESS_TOKEN:-}" ]]; then
    node "$ROOT/scripts/desktop-pairing.mjs" --start --platform-base-url "$pairing_url" --access-token "$PLATFORM_ACCESS_TOKEN" --env-file "$env_file"
  else
    node "$ROOT/scripts/desktop-pairing.mjs" --start --platform-base-url "$pairing_url" --env-file "$env_file"
  fi

  node "$ROOT/scripts/desktop-pairing.mjs" --wait --platform-base-url "$pairing_url" --env-file "$env_file"
}

install_local_services() {
  case "$OS" in
    Darwin)
      CONFIG_ENV_FILE="$ENV_FILE" npm --prefix "$ROOT" run runner:install-launchd
      CONFIG_ENV_FILE="$ENV_FILE" npm --prefix "$ROOT" run connector:install-launchd
      CONFIG_ENV_FILE="$ENV_FILE" npm --prefix "$ROOT" run runner:start
      CONFIG_ENV_FILE="$ENV_FILE" npm --prefix "$ROOT" run connector:start
      ;;
    Linux)
      mkdir -p "$HOME/.config/systemd/user"
      cat > "$HOME/.config/systemd/user/codex-relay-runner.service" <<UNIT
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
UNIT

      cat > "$HOME/.config/systemd/user/codex-relay-connector.service" <<UNIT
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
UNIT

      systemctl --user daemon-reload
      systemctl --user enable --now codex-relay-runner.service
      systemctl --user enable --now codex-relay-connector.service
      ;;
    *)
      fail "Unsupported OS: $OS"
      ;;
  esac
}

run_doctor_with_retry() {
  local max_try=5
  local i
  for ((i=1; i<=max_try; i+=1)); do
    if CONFIG_ENV_FILE="$ENV_FILE" bash "$ROOT/deploy/agent/doctor.sh"; then
      log "doctor passed"
      return
    fi
    if (( i == max_try )); then
      fail "doctor failed after ${max_try} attempts"
    fi
    log "doctor retry ${i}/${max_try} ..."
    sleep 3
  done
}

main() {
  ensure_env_file
  ensure_node_npm

  cd "$ROOT"
  npm ci

  ensure_secret_key RELAY_TOKEN 32
  ensure_codex_cli
  ensure_codex_login
  start_local_platform_api_if_needed

  run_pairing_flow "$ENV_FILE"
  install_local_services
  run_doctor_with_retry

  log "quick guide finished"
  log "platform API: ${PLATFORM_BASE_URL:-$PLATFORM_DEFAULT_LOCAL}"
  log "next: open iPhone app -> login -> scan setup QR"
}

main "$@"
