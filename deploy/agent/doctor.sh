#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${CONFIG_ENV_FILE:-$ROOT/config/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

FAIL=0
CODEX_BIN="${CODEX_BIN:-codex}"

if command -v "$CODEX_BIN" >/dev/null 2>&1; then
  CODEX_STATUS="$("$CODEX_BIN" login status 2>&1 || true)"
  if echo "$CODEX_STATUS" | grep -qi "logged in"; then
    echo "[OK] codex login"
  else
    echo "[FAIL] codex login"
    echo "       $CODEX_STATUS"
    FAIL=1
  fi
else
  echo "[FAIL] codex binary missing: $CODEX_BIN"
  FAIL=1
fi

if [[ -z "${RELAY_BASE_URL:-}" ]]; then
  echo "[FAIL] RELAY_BASE_URL missing"
  FAIL=1
else
  echo "[OK] RELAY_BASE_URL"
fi

if [[ -z "${RELAY_TOKEN:-}" ]]; then
  echo "[FAIL] RELAY_TOKEN missing"
  FAIL=1
else
  echo "[OK] RELAY_TOKEN"
fi

if curl -fsS "${RELAY_BASE_URL%/}/healthz" >/dev/null; then
  echo "[OK] relay /healthz"
else
  echo "[FAIL] relay /healthz"
  FAIL=1
fi

if curl -fsS -H "Authorization: Bearer ${RELAY_TOKEN}" "${RELAY_BASE_URL%/}/codex-iphone-connector/status?workspace=*" >/dev/null; then
  echo "[OK] relay auth"
else
  echo "[FAIL] relay auth"
  FAIL=1
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  CONFIG_ENV_FILE="$ENV_FILE" npm --prefix "$ROOT" run runner:status || FAIL=1
  CONFIG_ENV_FILE="$ENV_FILE" npm --prefix "$ROOT" run connector:status || FAIL=1
elif [[ "$(uname -s)" == "Linux" ]]; then
  systemctl --user is-active --quiet codex-relay-runner.service && echo "[OK] runner service" || { echo "[FAIL] runner service"; FAIL=1; }
  systemctl --user is-active --quiet codex-relay-connector.service && echo "[OK] connector service" || { echo "[FAIL] connector service"; FAIL=1; }
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "doctor found issues"
  exit 1
fi

echo "doctor passed"
