#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REMOTE_HOST="${REMOTE_HOST:-aliyun}"
REMOTE_DIR="${REMOTE_DIR:-/var/www/codexiphone}"
SITE_PATH="${SITE_PATH:-/codexiphone/}"
GUIDE_DOMAIN="${GUIDE_DOMAIN:-my-agent.com.cn}"
LOCAL_SITE_DIR="$ROOT/docs/site/codexiphone"

if [[ ! -d "$LOCAL_SITE_DIR" ]]; then
  echo "missing site dir: $LOCAL_SITE_DIR" >&2
  exit 1
fi

for required in index.html install.sh install.ps1; do
  if [[ ! -f "$LOCAL_SITE_DIR/$required" ]]; then
    echo "missing $LOCAL_SITE_DIR/$required" >&2
    exit 1
  fi
done

chmod +x "$LOCAL_SITE_DIR/install.sh"

ssh "$REMOTE_HOST" "mkdir -p '$REMOTE_DIR'"
tar -C "$LOCAL_SITE_DIR" -cf - . | ssh "$REMOTE_HOST" "tar -C '$REMOTE_DIR' -xf -"

SITE_PATH_NORMALIZED="/${SITE_PATH#/}"
GUIDE_URL="https://${GUIDE_DOMAIN}${SITE_PATH_NORMALIZED}"
INSTALL_SH_URL="https://${GUIDE_DOMAIN}${SITE_PATH_NORMALIZED%/}/install.sh"
INSTALL_PS1_URL="https://${GUIDE_DOMAIN}${SITE_PATH_NORMALIZED%/}/install.ps1"

STATUS_GUIDE="$(curl -o /dev/null -s -w '%{http_code}' "$GUIDE_URL" || true)"
STATUS_SH="$(curl -o /dev/null -s -w '%{http_code}' "$INSTALL_SH_URL" || true)"
STATUS_PS1="$(curl -o /dev/null -s -w '%{http_code}' "$INSTALL_PS1_URL" || true)"

echo "deployed guide: $GUIDE_URL (http_status=${STATUS_GUIDE:-unknown})"
echo "deployed install.sh: $INSTALL_SH_URL (http_status=${STATUS_SH:-unknown})"
echo "deployed install.ps1: $INSTALL_PS1_URL (http_status=${STATUS_PS1:-unknown})"
