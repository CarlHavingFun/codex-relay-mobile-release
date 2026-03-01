#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/codex_relay_mobile}"
ENV_FILE="${ENV_FILE:-$INSTALL_DIR/config/.env}"
SERVICE_NAME="${SERVICE_NAME:-codex-relay}"
RELAY_DOMAIN="${RELAY_DOMAIN:-}"
WATCHDOG_SERVICE_NAME="${WATCHDOG_SERVICE_NAME:-${SERVICE_NAME}-watchdog}"
WATCHDOG_UNIT_BASENAME="${WATCHDOG_SERVICE_NAME%.service}"
WATCHDOG_SERVICE_UNIT="${WATCHDOG_UNIT_BASENAME}.service"
WATCHDOG_TIMER_UNIT="${WATCHDOG_UNIT_BASENAME}.timer"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

FAIL=0
LOCAL_RELAY_PORT="${RELAY_PORT:-8787}"

echo "== systemd =="
if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "[OK] $SERVICE_NAME active"
else
  echo "[FAIL] $SERVICE_NAME inactive"
  FAIL=1
fi

echo
echo "== local health =="
if curl -fsS "http://127.0.0.1:${LOCAL_RELAY_PORT}/healthz" >/dev/null; then
  echo "[OK] local relay health"
else
  echo "[FAIL] local relay health"
  FAIL=1
fi

echo
echo "== auth endpoint =="
if curl -fsS -H "Authorization: Bearer ${RELAY_TOKEN}" "http://127.0.0.1:${LOCAL_RELAY_PORT}/legacy-runner/status?workspace=${DEFAULT_WORKSPACE:-default}" >/dev/null; then
  echo "[OK] auth status endpoint"
else
  echo "[FAIL] auth status endpoint"
  FAIL=1
fi

echo
echo "== bind check (${LOCAL_RELAY_PORT} should be local only) =="
if ss -ltn | grep -qE "127\\.0\\.0\\.1:${LOCAL_RELAY_PORT}|\\[::1\\]:${LOCAL_RELAY_PORT}"; then
  echo "[OK] ${LOCAL_RELAY_PORT} bound to loopback"
else
  echo "[WARN] ${LOCAL_RELAY_PORT} not clearly loopback-only; verify firewall/reverse-proxy policy"
fi

echo
echo "== watchdog =="
if systemctl is-enabled --quiet "$WATCHDOG_TIMER_UNIT"; then
  echo "[OK] $WATCHDOG_TIMER_UNIT enabled"
else
  echo "[FAIL] $WATCHDOG_TIMER_UNIT not enabled"
  FAIL=1
fi

if systemctl is-active --quiet "$WATCHDOG_TIMER_UNIT"; then
  echo "[OK] $WATCHDOG_TIMER_UNIT active"
else
  echo "[FAIL] $WATCHDOG_TIMER_UNIT inactive"
  FAIL=1
fi

WATCHDOG_RESULT="$(systemctl show "$WATCHDOG_SERVICE_UNIT" -p Result --value 2>/dev/null || true)"
WATCHDOG_LAST_RUN="$(systemctl show "$WATCHDOG_TIMER_UNIT" -p LastTriggerUSec --value 2>/dev/null || true)"
if [[ -n "$WATCHDOG_LAST_RUN" && "$WATCHDOG_LAST_RUN" != "0" ]]; then
  echo "[OK] watchdog last trigger (usec): $WATCHDOG_LAST_RUN"
else
  echo "[WARN] watchdog has not triggered yet"
fi
if [[ "$WATCHDOG_RESULT" == "failed" ]]; then
  echo "[FAIL] $WATCHDOG_SERVICE_UNIT last result: failed"
  FAIL=1
elif [[ -n "$WATCHDOG_RESULT" ]]; then
  echo "[OK] $WATCHDOG_SERVICE_UNIT last result: $WATCHDOG_RESULT"
fi

if [[ -n "$RELAY_DOMAIN" ]]; then
  echo
  echo "== https health =="
  if curl -fsS "https://${RELAY_DOMAIN}/healthz" >/dev/null; then
    echo "[OK] https relay health"
  else
    echo "[FAIL] https relay health"
    FAIL=1
  fi
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "doctor found issues"
  exit 1
fi

echo "doctor passed"
