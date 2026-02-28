#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/codex_relay_mobile}"
ENV_FILE="${ENV_FILE:-$INSTALL_DIR/config/.env}"
SERVICE_NAME="${SERVICE_NAME:-codex-relay}"
RELAY_DOMAIN="${RELAY_DOMAIN:-}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

FAIL=0

echo "== systemd =="
if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "[OK] $SERVICE_NAME active"
else
  echo "[FAIL] $SERVICE_NAME inactive"
  FAIL=1
fi

echo
echo "== local health =="
if curl -fsS http://127.0.0.1:8787/healthz >/dev/null; then
  echo "[OK] local relay health"
else
  echo "[FAIL] local relay health"
  FAIL=1
fi

echo
echo "== auth endpoint =="
if curl -fsS -H "Authorization: Bearer ${RELAY_TOKEN}" "http://127.0.0.1:8787/legacy-runner/status?workspace=${DEFAULT_WORKSPACE:-default}" >/dev/null; then
  echo "[OK] auth status endpoint"
else
  echo "[FAIL] auth status endpoint"
  FAIL=1
fi

echo
echo "== bind check (8787 should be local only) =="
if ss -ltn | grep -qE '127\.0\.0\.1:8787|\[::1\]:8787'; then
  echo "[OK] 8787 bound to loopback"
else
  echo "[WARN] 8787 not clearly loopback-only; verify firewall/reverse-proxy policy"
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
