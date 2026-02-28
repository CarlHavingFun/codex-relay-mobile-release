#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer targets macOS." >&2
  exit 1
fi

OS_VERSION="$(sw_vers -productVersion)"
OS_MAJOR="${OS_VERSION%%.*}"
if [[ "$OS_MAJOR" -lt 14 ]]; then
  echo "warning: macOS 14+ recommended, detected $OS_VERSION"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (recommended >= 20)." >&2
  echo "Install from https://nodejs.org or: brew install node"
  exit 1
fi

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "warning: Node.js 20+ recommended, detected $(node -v)"
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required." >&2
  exit 1
fi

cd "$ROOT"
echo "Installing npm dependencies..."
npm ci

echo "mac mini prerequisites ready."
echo "Next: ./deploy/macmini/init-env.sh"
