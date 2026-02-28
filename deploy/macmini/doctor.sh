#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/config/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

check_required() {
  local key="$1"
  local value="${!key:-}"
  if [[ -z "$value" ]]; then
    echo "[FAIL] $key is empty"
    return 1
  fi
  if [[ "$value" == *replace-with-strong-token* ]]; then
    echo "[FAIL] $key still uses placeholder value"
    return 1
  fi
  echo "[OK] $key"
}

FAIL=0
check_required RELAY_BASE_URL || FAIL=1
check_required RELAY_TOKEN || FAIL=1
check_required SERVICE_LABEL_PREFIX || FAIL=1

echo
echo "== Runner status =="
( cd "$ROOT" && npm run runner:status ) || FAIL=1

echo
echo "== Connector status =="
( cd "$ROOT" && npm run connector:status ) || FAIL=1

echo
echo "== Relay connectivity =="
if curl -fsS "${RELAY_BASE_URL%/}/healthz" >/dev/null; then
  echo "[OK] ${RELAY_BASE_URL%/}/healthz"
else
  echo "[FAIL] cannot reach ${RELAY_BASE_URL%/}/healthz"
  FAIL=1
fi

if curl -fsS -H "Authorization: Bearer $RELAY_TOKEN" "${RELAY_BASE_URL%/}/legacy-runner/status?workspace=default" >/dev/null; then
  echo "[OK] auth status endpoint"
else
  echo "[FAIL] auth status endpoint"
  FAIL=1
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "doctor found issues"
  exit 1
fi

echo "doctor passed"
