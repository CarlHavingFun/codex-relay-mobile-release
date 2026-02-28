#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REMOTE_HOST="${REMOTE_HOST:-aliyun}"
REMOTE_DIR="${REMOTE_DIR:-/var/www/clawdpet-home/codex-relay-mobile}"
LOCAL_SITE_DIR="$ROOT/docs/site"

if [[ ! -f "$LOCAL_SITE_DIR/guide.html" ]]; then
  echo "missing $LOCAL_SITE_DIR/guide.html" >&2
  exit 1
fi

ssh "$REMOTE_HOST" "mkdir -p '$REMOTE_DIR'"
scp "$LOCAL_SITE_DIR/guide.html" "$REMOTE_HOST:$REMOTE_DIR/index.html"

URL="https://my-agent.com.cn/clawdpet-home/codex-relay-mobile/"
STATUS="$(curl -o /dev/null -s -w '%{http_code}' "$URL" || true)"

echo "deployed: $URL"
echo "http_status: ${STATUS:-unknown}"
