#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/config/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Run ./deploy/macmini/init-env.sh first." >&2
  exit 1
fi

cd "$ROOT"
npm ci

npm run runner:install-launchd
npm run connector:install-launchd

npm run runner:start
npm run connector:start

npm run runner:status || true
npm run connector:status || true

echo "Bootstrap complete."
