#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-codex-relay}"
INSTALL_DIR="${INSTALL_DIR:-/opt/codex_relay_mobile}"
ENV_FILE="${ENV_FILE:-$INSTALL_DIR/config/.env}"
WATCHDOG_STATE_DIR="${WATCHDOG_STATE_DIR:-/var/lib/${SERVICE_NAME}}"
WATCHDOG_MAX_FAILS="${WATCHDOG_MAX_FAILS:-3}"
WATCHDOG_CHECK_AUTH="${WATCHDOG_CHECK_AUTH:-1}"
FAIL_COUNT_FILE="${WATCHDOG_STATE_DIR}/watchdog_fail.count"

log() {
  local msg="[relay-watchdog:${SERVICE_NAME}] $*"
  if command -v logger >/dev/null 2>&1; then
    logger -t "${SERVICE_NAME}-watchdog" -- "$msg"
  fi
  echo "$msg"
}

read_fail_count() {
  if [[ -f "$FAIL_COUNT_FILE" ]]; then
    cat "$FAIL_COUNT_FILE" 2>/dev/null || echo "0"
    return
  fi
  echo "0"
}

write_fail_count() {
  local count="$1"
  mkdir -p "$WATCHDOG_STATE_DIR"
  printf '%s\n' "$count" > "$FAIL_COUNT_FILE"
}

if [[ ! -f "$ENV_FILE" ]]; then
  log "env file missing: $ENV_FILE"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

RELAY_PORT="${RELAY_PORT:-8787}"
DEFAULT_WORKSPACE="${DEFAULT_WORKSPACE:-default}"
PRIMARY_URL="http://127.0.0.1:${RELAY_PORT}/healthz"
AUTH_URL="http://127.0.0.1:${RELAY_PORT}/legacy-runner/status?workspace=${DEFAULT_WORKSPACE}"

primary_ok=0
auth_ok=0

if curl -fsS --max-time 5 "$PRIMARY_URL" >/dev/null 2>&1; then
  primary_ok=1
fi

if [[ "$WATCHDOG_CHECK_AUTH" == "1" ]] && [[ -n "${RELAY_TOKEN:-}" ]]; then
  if curl -fsS --max-time 6 -H "Authorization: Bearer ${RELAY_TOKEN}" "$AUTH_URL" >/dev/null 2>&1; then
    auth_ok=1
  fi
else
  auth_ok=1
fi

fail_count="$(read_fail_count)"
if ! [[ "$fail_count" =~ ^[0-9]+$ ]]; then
  fail_count=0
fi
if ! [[ "$WATCHDOG_MAX_FAILS" =~ ^[0-9]+$ ]] || [[ "$WATCHDOG_MAX_FAILS" -lt 1 ]]; then
  WATCHDOG_MAX_FAILS=3
fi

if [[ "$primary_ok" -eq 1 ]] && [[ "$auth_ok" -eq 1 ]]; then
  if [[ "$fail_count" -gt 0 ]]; then
    log "health restored; reset failure counter (was $fail_count)"
  fi
  write_fail_count 0
  exit 0
fi

fail_count=$((fail_count + 1))
write_fail_count "$fail_count"
log "health check failed (healthz=$primary_ok auth=$auth_ok fail_count=$fail_count/$WATCHDOG_MAX_FAILS)"

if [[ "$fail_count" -lt "$WATCHDOG_MAX_FAILS" ]]; then
  exit 0
fi

log "failure threshold reached; restarting ${SERVICE_NAME}"
if systemctl restart "$SERVICE_NAME"; then
  write_fail_count 0
  log "restart issued successfully"
  exit 0
fi

log "restart failed"
exit 1
