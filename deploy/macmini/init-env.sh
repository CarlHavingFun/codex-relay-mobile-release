#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_EXAMPLE="$ROOT/config/.env.example"
ENV_FILE="$ROOT/config/.env"

if [[ ! -f "$ENV_EXAMPLE" ]]; then
  echo "missing env template: $ENV_EXAMPLE" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
fi

set_kv() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i.bak "s#^${key}=.*#${key}=${value}#" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

prompt_default() {
  local label="$1"
  local default="$2"
  local out=""
  if [[ -t 0 ]]; then
    read -r -p "$label [$default]: " out
  fi
  out="${out:-$default}"
  printf '%s' "$out"
}

rand_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    date +%s | shasum | awk '{print $1}'
  fi
}

RELAY_BASE_URL="$(prompt_default 'Relay Base URL' 'https://relay.example.com')"
RELAY_TOKEN="$(prompt_default 'Relay Bearer Token' "$(rand_token)")"
WORKSPACE_PATH="$(prompt_default 'Workspace path (legacy runner support)' "$ROOT")"
PLAN_FILE="$(prompt_default 'PLAN file path (legacy runner support)' "$ROOT/PLAN.md")"
SERVICE_LABEL_PREFIX="$(prompt_default 'Service label prefix' 'com.yourorg.codexrelay')"

set_kv RELAY_BASE_URL "$RELAY_BASE_URL"
set_kv RELAY_TOKEN "$RELAY_TOKEN"
set_kv WORKSPACE_PATH "$WORKSPACE_PATH"
set_kv PLAN_FILE "$PLAN_FILE"
set_kv STATE_DIR "$ROOT/state"
set_kv SERVICE_LABEL_PREFIX "$SERVICE_LABEL_PREFIX"
set_kv CONNECTOR_WORKSPACE "default"
set_kv DEFAULT_WORKSPACE "default"

if [[ ! -f "$PLAN_FILE" ]]; then
  mkdir -p "$(dirname "$PLAN_FILE")"
  cat > "$PLAN_FILE" <<'PLAN'
# PLAN

- [ ] [AUTO] Replace with your first task.
PLAN
fi

chmod 600 "$ENV_FILE"
rm -f "$ENV_FILE.bak"

echo "Wrote: $ENV_FILE"
echo "Next: ./deploy/macmini/bootstrap.sh"
